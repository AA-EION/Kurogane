//! Inactivity and suspend detection for the timed session lock.
//!
//! The desktop shell calls [`SessionClock::touch`] on user activity and
//! [`SessionClock::poll`] once per second. When `poll` returns a reason, the
//! shell drops the unlocked vault, which zeroizes every key page.
//!
//! Suspend detection is portable: monotonic clocks on Linux
//! (`CLOCK_MONOTONIC`) and macOS (`mach_absolute_time`) stop while the machine
//! sleeps, but wall-clock time keeps going. A wall-clock jump much larger than
//! the monotonic delta between two polls therefore means the machine slept.
//! Native screen-lock / sleep notifications (logind `PrepareForSleep`,
//! `NSWorkspaceWillSleepNotification`, `WTS_SESSION_LOCK`) feed
//! [`SessionClock::force_lock`] where the shell has them.

use std::time::Duration;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LockReason {
    Inactivity,
    SystemSuspend,
    ScreenLocked,
    Manual,
}

/// Abstract clock so the logic is unit-testable.
pub trait Clock: Send {
    /// Monotonic time since an arbitrary epoch.
    fn monotonic(&self) -> Duration;
    /// Wall-clock time since the Unix epoch.
    fn wall(&self) -> Duration;
}

pub struct SystemClock {
    origin: std::time::Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        Self { origin: std::time::Instant::now() }
    }
}

impl Clock for SystemClock {
    fn monotonic(&self) -> Duration {
        self.origin.elapsed()
    }
    fn wall(&self) -> Duration {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default()
    }
}

pub struct SessionClock<C: Clock = SystemClock> {
    clock: C,
    timeout: Duration,
    last_activity: Duration,
    last_poll_mono: Duration,
    last_poll_wall: Duration,
    forced: Option<LockReason>,
    /// Wall/monotonic divergence that counts as a suspend.
    pub suspend_threshold: Duration,
}

impl SessionClock<SystemClock> {
    pub fn new(timeout: Duration) -> Self {
        Self::with_clock(SystemClock::default(), timeout)
    }
}

impl<C: Clock> SessionClock<C> {
    pub fn with_clock(clock: C, timeout: Duration) -> Self {
        let mono = clock.monotonic();
        let wall = clock.wall();
        Self {
            clock,
            timeout,
            last_activity: mono,
            last_poll_mono: mono,
            last_poll_wall: wall,
            forced: None,
            suspend_threshold: Duration::from_secs(15),
        }
    }

    pub fn touch(&mut self) {
        self.last_activity = self.clock.monotonic();
    }

    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    pub fn force_lock(&mut self, reason: LockReason) {
        self.forced = Some(reason);
    }

    pub fn remaining(&self) -> Duration {
        self.timeout.saturating_sub(self.clock.monotonic().saturating_sub(self.last_activity))
    }

    pub fn poll(&mut self) -> Option<LockReason> {
        if let Some(r) = self.forced.take() {
            return Some(r);
        }
        let mono = self.clock.monotonic();
        let wall = self.clock.wall();
        let mono_delta = mono.saturating_sub(self.last_poll_mono);
        let wall_delta = wall.saturating_sub(self.last_poll_wall);
        self.last_poll_mono = mono;
        self.last_poll_wall = wall;
        if wall_delta > mono_delta + self.suspend_threshold {
            return Some(LockReason::SystemSuspend);
        }
        if mono.saturating_sub(self.last_activity) >= self.timeout {
            return Some(LockReason::Inactivity);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct FakeClock(Arc<Mutex<(Duration, Duration)>>);
    impl FakeClock {
        fn advance(&self, mono: u64, wall: u64) {
            let mut g = self.0.lock().unwrap();
            g.0 += Duration::from_secs(mono);
            g.1 += Duration::from_secs(wall);
        }
    }
    impl Clock for FakeClock {
        fn monotonic(&self) -> Duration {
            self.0.lock().unwrap().0
        }
        fn wall(&self) -> Duration {
            self.0.lock().unwrap().1
        }
    }

    #[test]
    fn locks_after_inactivity_and_touch_resets() {
        let c = FakeClock::default();
        let mut s = SessionClock::with_clock(c.clone(), Duration::from_secs(300));
        c.advance(200, 200);
        assert_eq!(s.poll(), None);
        s.touch();
        c.advance(200, 200);
        assert_eq!(s.poll(), None);
        assert_eq!(s.remaining(), Duration::from_secs(100));
        c.advance(100, 100);
        assert_eq!(s.poll(), Some(LockReason::Inactivity));
    }

    #[test]
    fn detects_suspend_via_clock_divergence() {
        let c = FakeClock::default();
        let mut s = SessionClock::with_clock(c.clone(), Duration::from_secs(3600));
        c.advance(1, 1);
        assert_eq!(s.poll(), None);
        // Laptop lid closed for 10 minutes: monotonic barely moves.
        c.advance(1, 600);
        assert_eq!(s.poll(), Some(LockReason::SystemSuspend));
    }

    #[test]
    fn forced_lock_wins() {
        let mut s = SessionClock::with_clock(FakeClock::default(), Duration::from_secs(3600));
        s.force_lock(LockReason::ScreenLocked);
        assert_eq!(s.poll(), Some(LockReason::ScreenLocked));
        assert_eq!(s.poll(), None);
    }
}
