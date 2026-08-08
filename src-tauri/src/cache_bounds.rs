/// Renderer IPC cache keys are identifiers, not data storage. Keep them small
/// enough to avoid pathological object-map and serialized-file overhead.
pub(crate) const MAX_CACHE_KEY_BYTES: usize = 1024;

/// A single cached dataset may be large (the desktop cache commonly exceeds
/// 10 MiB in aggregate), but no one renderer call may add an unbounded value.
pub(crate) const MAX_CACHE_VALUE_BYTES: usize = 5 * 1024 * 1024;

pub(crate) fn validate_cache_write_sizes(key: &str, value: &str) -> Result<(), String> {
    let key_bytes = key.len();
    if key_bytes > MAX_CACHE_KEY_BYTES {
        return Err(format!(
            "cache key exceeds {MAX_CACHE_KEY_BYTES} byte limit ({key_bytes} bytes)"
        ));
    }

    let value_bytes = value.len();
    if value_bytes > MAX_CACHE_VALUE_BYTES {
        return Err(format!(
            "cache payload exceeds {MAX_CACHE_VALUE_BYTES} byte limit ({value_bytes} bytes)"
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_cache_keys_and_values_at_the_explicit_limits() {
        assert!(validate_cache_write_sizes(
            &"k".repeat(MAX_CACHE_KEY_BYTES),
            &"v".repeat(MAX_CACHE_VALUE_BYTES),
        )
        .is_ok());
    }

    #[test]
    fn rejects_cache_keys_over_the_limit() {
        let error = validate_cache_write_sizes(
            &"k".repeat(MAX_CACHE_KEY_BYTES + 1),
            "{}",
        )
        .expect_err("oversized keys must be rejected");
        assert!(error.contains("cache key exceeds"));
    }

    #[test]
    fn rejects_cache_values_over_the_limit() {
        let error = validate_cache_write_sizes(
            "news:latest",
            &"v".repeat(MAX_CACHE_VALUE_BYTES + 1),
        )
        .expect_err("oversized values must be rejected");
        assert!(error.contains("cache payload exceeds"));
    }
}
