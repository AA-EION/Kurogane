//! RFC 6238 TOTP, compatible with Google Authenticator, Authy, 1Password, Aegis.
//!
//! **Portability:** the seed is sealed with `HKDF(VDK, "kurogane/v1/totp")` and
//! stored inside the SQLCipher database, which itself lives inside the
//! encrypted container. Copying the `.kurogane` file to a new machine and
//! entering the master password recovers the seed, so the user's existing
//! authenticator entry keeps working without re-enrolment.
//!
//! **Threat-model note (documented in `docs/CRYPTO.md`):** an offline verifier
//! must hold the seed, so TOTP here is a *policy* factor enforced by the app
//! (shoulder-surfed or key-logged passwords are not enough at the keyboard). It
//! adds no cryptographic strength against an attacker who has both the vault
//! file *and* the master password.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use crate::error::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Algorithm {
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            Algorithm::Sha1 => "SHA1",
            Algorithm::Sha256 => "SHA256",
            Algorithm::Sha512 => "SHA512",
        }
    }
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "SHA1" => Ok(Algorithm::Sha1),
            "SHA256" => Ok(Algorithm::Sha256),
            "SHA512" => Ok(Algorithm::Sha512),
            _ => Err(Error::invalid(format!("unknown TOTP algorithm {s}"))),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TotpConfig {
    pub algorithm: Algorithm,
    pub digits: u32,
    pub period: u64,
}

impl Default for TotpConfig {
    /// SHA1 / 6 digits / 30 s: the only combination every mainstream
    /// authenticator app supports.
    fn default() -> Self {
        Self { algorithm: Algorithm::Sha1, digits: 6, period: 30 }
    }
}

/// 160-bit seed, the length RFC 4226 §4 recommends for HMAC-SHA1.
pub fn generate_secret() -> zeroize::Zeroizing<Vec<u8>> {
    zeroize::Zeroizing::new(crate::crypto::random_bytes::<20>().to_vec())
}

pub fn counter_at(cfg: &TotpConfig, unix_time: u64) -> u64 {
    unix_time / cfg.period
}

/// HOTP (RFC 4226 §5.3) with dynamic truncation.
pub fn hotp(secret: &[u8], cfg: &TotpConfig, counter: u64) -> String {
    let msg = counter.to_be_bytes();
    macro_rules! mac {
        ($d:ty) => {{
            let mut m = Hmac::<$d>::new_from_slice(secret).expect("HMAC accepts any key length");
            m.update(&msg);
            m.finalize().into_bytes().to_vec()
        }};
    }
    let digest: Vec<u8> = match cfg.algorithm {
        Algorithm::Sha1 => mac!(sha1::Sha1),
        Algorithm::Sha256 => mac!(sha2::Sha256),
        Algorithm::Sha512 => mac!(sha2::Sha512),
    };
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let bin = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | digest[offset + 3] as u32;
    let modulo = 10u32.pow(cfg.digits);
    format!("{:0width$}", bin % modulo, width = cfg.digits as usize)
}

pub fn code_at(secret: &[u8], cfg: &TotpConfig, unix_time: u64) -> String {
    hotp(secret, cfg, counter_at(cfg, unix_time))
}

/// Verify `code` within ±`window` steps of `unix_time`. Returns the matched
/// counter. Counters `<= last_used_counter` are rejected (replay protection);
/// the caller persists the returned counter.
pub fn verify(secret: &[u8], cfg: &TotpConfig, code: &str, unix_time: u64, window: u64, last_used_counter: u64) -> Option<u64> {
    let code = code.trim().replace(' ', "");
    if code.len() != cfg.digits as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let now = counter_at(cfg, unix_time);
    let mut matched = None;
    // Check every candidate (no early exit) to keep timing independent of
    // which step matched.
    for c in now.saturating_sub(window)..=now + window {
        let candidate = hotp(secret, cfg, c);
        if bool::from(candidate.as_bytes().ct_eq(code.as_bytes())) && c > last_used_counter {
            matched = Some(c);
        }
    }
    matched
}

pub fn secret_to_base32(secret: &[u8]) -> String {
    data_encoding::BASE32_NOPAD.encode(secret)
}

pub fn secret_from_base32(s: &str) -> Result<Vec<u8>> {
    let cleaned: String = s.chars().filter(|c| !c.is_whitespace() && *c != '=').collect::<String>().to_uppercase();
    data_encoding::BASE32_NOPAD.decode(cleaned.as_bytes()).map_err(|_| Error::invalid("TOTP secret is not valid base32"))
}

/// `otpauth://` URI per the Google Authenticator Key URI format.
pub fn otpauth_uri(secret: &[u8], cfg: &TotpConfig, issuer: &str, account: &str) -> String {
    let enc = |s: &str| {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect::<String>()
    };
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm={}&digits={}&period={}",
        enc(issuer),
        enc(account),
        secret_to_base32(secret),
        enc(issuer),
        cfg.algorithm.as_str(),
        cfg.digits,
        cfg.period
    )
}

/// Render the enrolment URI as a standalone SVG QR code.
pub fn qr_svg(data: &str) -> Result<String> {
    use qrcode::render::svg;
    let code = qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::M)
        .map_err(|e| Error::invalid(format!("QR encode: {e}")))?;
    Ok(code
        .render::<svg::Color<'_>>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .dark_color(svg::Color("#0b0d10"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B test vectors (8 digits).
    #[test]
    fn rfc6238_vectors() {
        let s1 = b"12345678901234567890";
        let s256 = b"12345678901234567890123456789012";
        let s512 = b"1234567890123456789012345678901234567890123456789012345678901234";
        let cases: &[(u64, &str, &str, &str)] = &[
            (59, "94287082", "46119246", "90693936"),
            (1111111109, "07081804", "68084774", "25091201"),
            (1111111111, "14050471", "67062674", "99943326"),
            (1234567890, "89005924", "91819424", "93441116"),
            (2000000000, "69279037", "90698825", "38618901"),
            (20000000000, "65353130", "77737706", "47863826"),
        ];
        for &(t, e1, e256, e512) in cases {
            let c = |a| TotpConfig { algorithm: a, digits: 8, period: 30 };
            assert_eq!(code_at(s1, &c(Algorithm::Sha1), t), e1, "sha1 t={t}");
            assert_eq!(code_at(s256, &c(Algorithm::Sha256), t), e256, "sha256 t={t}");
            assert_eq!(code_at(s512, &c(Algorithm::Sha512), t), e512, "sha512 t={t}");
        }
    }

    #[test]
    fn verify_window_and_replay() {
        let secret = generate_secret();
        let cfg = TotpConfig::default();
        let t = 1_800_000_000;
        let code = code_at(&secret, &cfg, t);
        let ctr = verify(&secret, &cfg, &code, t + 25, 1, 0).expect("within window");
        assert_eq!(ctr, counter_at(&cfg, t));
        assert!(verify(&secret, &cfg, &code, t, 1, ctr).is_none(), "replay must fail");
        assert!(verify(&secret, &cfg, &code, t + 120, 1, 0).is_none(), "outside window");
        assert!(verify(&secret, &cfg, "12a456", t, 1, 0).is_none());
    }

    #[test]
    fn base32_and_uri() {
        let s = b"12345678901234567890";
        let b32 = secret_to_base32(s);
        assert_eq!(b32, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert_eq!(secret_from_base32(&b32.to_lowercase()).unwrap(), s);
        let uri = otpauth_uri(s, &TotpConfig::default(), "Kurogane", "ops@example.com");
        assert!(uri.starts_with("otpauth://totp/Kurogane:ops%40example.com?secret=GEZD"));
        assert!(qr_svg(&uri).unwrap().contains("<svg"));
    }
}
