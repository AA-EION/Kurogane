//! Page-locked, zeroize-on-drop storage for long-lived key material.
//!
//! Each [`SecretBox`] owns whole, page-aligned pages. That matters because
//! `munlock` does not reference-count: if two keys shared a page, dropping one
//! would silently unlock the other. The pages are:
//!
//! * `mlock`/`VirtualLock`ed so they are never written to swap,
//! * excluded from core dumps on Linux (`MADV_DONTDUMP`),
//! * overwritten with zeros (via `zeroize`, which the optimiser cannot elide)
//!   before being unlocked and freed.
//!
//! Locking can fail (e.g. a tiny `RLIMIT_MEMLOCK`). The box still works and
//! reports [`SecretBox::is_memory_locked`] = `false` so the UI can warn.

use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::fmt;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};

use zeroize::Zeroize;

static LOCK_FAILURE_SEEN: AtomicBool = AtomicBool::new(false);

/// Returns `true` if any secret allocation failed to lock its memory during
/// this process lifetime (swap exposure possible).
pub fn memory_lock_degraded() -> bool {
    LOCK_FAILURE_SEEN.load(Ordering::Relaxed)
}

pub struct SecretBox<const N: usize> {
    ptr: NonNull<u8>,
    layout: Layout,
    locked: bool,
}

// SAFETY: SecretBox uniquely owns its allocation; access is mediated by &/&mut.
unsafe impl<const N: usize> Send for SecretBox<N> {}
unsafe impl<const N: usize> Sync for SecretBox<N> {}

/// A 256-bit key in locked memory.
pub type Key256 = SecretBox<32>;

impl<const N: usize> SecretBox<N> {
    pub fn new_zeroed() -> Self {
        let page = region::page::size();
        let size = N.max(1).div_ceil(page) * page;
        let layout = Layout::from_size_align(size, page).expect("valid page layout");
        // SAFETY: layout has non-zero size.
        let raw = unsafe { alloc_zeroed(layout) };
        let ptr = NonNull::new(raw).unwrap_or_else(|| std::alloc::handle_alloc_error(layout));
        let locked = lock_pages(ptr.as_ptr(), size);
        if !locked {
            LOCK_FAILURE_SEEN.store(true, Ordering::Relaxed);
        }
        Self { ptr, layout, locked }
    }

    pub fn from_slice(bytes: &[u8]) -> Self {
        assert_eq!(bytes.len(), N, "SecretBox::from_slice length mismatch");
        let mut s = Self::new_zeroed();
        s.expose_mut().copy_from_slice(bytes);
        s
    }

    /// Fresh key material from the OS CSPRNG.
    pub fn random() -> Self {
        let mut s = Self::new_zeroed();
        getrandom::getrandom(s.expose_mut()).expect("OS CSPRNG unavailable");
        s
    }

    pub fn expose(&self) -> &[u8; N] {
        // SAFETY: allocation is at least N bytes and page aligned.
        unsafe { &*(self.ptr.as_ptr() as *const [u8; N]) }
    }

    pub fn expose_mut(&mut self) -> &mut [u8; N] {
        // SAFETY: as above, and we hold &mut self.
        unsafe { &mut *(self.ptr.as_ptr() as *mut [u8; N]) }
    }

    pub fn try_clone(&self) -> Self {
        Self::from_slice(self.expose())
    }

    pub fn is_memory_locked(&self) -> bool {
        self.locked
    }
}

impl<const N: usize> Drop for SecretBox<N> {
    fn drop(&mut self) {
        // SAFETY: we own `layout.size()` bytes at `ptr`.
        unsafe {
            let all = std::slice::from_raw_parts_mut(self.ptr.as_ptr(), self.layout.size());
            all.zeroize();
            if self.locked {
                let _ = region::unlock(self.ptr.as_ptr() as *const u8, self.layout.size());
            }
            dealloc(self.ptr.as_ptr(), self.layout);
        }
    }
}

impl<const N: usize> fmt::Debug for SecretBox<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretBox<{N}>([REDACTED], locked={})", self.locked)
    }
}

fn lock_pages(ptr: *mut u8, size: usize) -> bool {
    #[cfg(target_os = "linux")]
    // SAFETY: advisory hint on memory we own.
    unsafe {
        libc::madvise(ptr as *mut libc::c_void, size, libc::MADV_DONTDUMP);
    }
    match region::lock(ptr as *const u8, size) {
        Ok(guard) => {
            // We unlock manually in Drop (after zeroizing), so the guard must not
            // run its own unlock first.
            std::mem::forget(guard);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_keys_differ_and_roundtrip() {
        let a = Key256::random();
        let b = Key256::random();
        assert_ne!(a.expose(), b.expose());
        let c = a.try_clone();
        assert_eq!(a.expose(), c.expose());
        assert!(format!("{a:?}").contains("REDACTED"));
    }

    #[test]
    fn each_box_owns_whole_pages() {
        let a = Key256::random();
        let page = region::page::size();
        assert_eq!(a.ptr.as_ptr() as usize % page, 0);
        assert_eq!(a.layout.size() % page, 0);
    }
}
