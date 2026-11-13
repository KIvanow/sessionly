//! Anthropic first-party API prices, used to estimate cost when a transcript has
//! no recorded total (a session that is still running, or one that crashed).
//!
//! Prices are USD per million tokens. Cache writes cost 1.25x input (5-minute
//! TTL) or 2x input (1-hour TTL). Cache reads vary by model. Checked against
//! Claude Code's own `cost-state` totals.

/// Per-million-token prices for one model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

impl Price {
    const fn new(input: f64, output: f64, cache_read: f64) -> Self {
        Price {
            input,
            output,
            cache_read,
        }
    }
    pub fn cache_write_5m(&self) -> f64 {
        self.input * 1.25
    }
    pub fn cache_write_1h(&self) -> f64 {
        self.input * 2.0
    }
}

/// Changes whenever the table below does, so stored estimates can be rebuilt.
pub const PRICING_VERSION: &str = "2026-10";

/// Prices as of 2026-10 (Anthropic API, first party). Bedrock and Vertex differ.
const PRICES: &[(&str, Price)] = &[
    ("claude-fable-5-1", Price::new(10.0, 50.0, 0.25)),
    ("claude-mythos-5-1", Price::new(10.0, 50.0, 0.25)),
    ("claude-fable-5", Price::new(10.0, 50.0, 1.00)),
    ("claude-mythos-5", Price::new(10.0, 50.0, 1.00)),
    ("claude-opus-5-5", Price::new(4.0, 20.0, 0.20)),
    ("claude-opus-5", Price::new(5.0, 25.0, 0.50)),
    ("claude-opus-4-8", Price::new(5.0, 25.0, 0.50)),
    ("claude-opus-4-7", Price::new(5.0, 25.0, 0.50)),
    ("claude-opus-4-6", Price::new(5.0, 25.0, 0.50)),
    ("claude-sonnet-5-5", Price::new(2.0, 10.0, 0.20)),
    ("claude-sonnet-5", Price::new(2.0, 10.0, 0.20)),
    ("claude-sonnet-4-6", Price::new(3.0, 15.0, 0.30)),
    ("claude-haiku-5-5", Price::new(0.10, 0.50, 0.01)),
    ("claude-haiku-4-5", Price::new(1.0, 5.0, 0.10)),
    // Older models that still show up in long-lived transcripts.
    ("claude-opus-4-5", Price::new(5.0, 25.0, 0.50)),
    ("claude-sonnet-4-5", Price::new(3.0, 15.0, 0.30)),
    ("claude-opus-4-1", Price::new(15.0, 75.0, 1.50)),
    ("claude-opus-4-0", Price::new(15.0, 75.0, 1.50)),
    ("claude-opus-4", Price::new(15.0, 75.0, 1.50)),
    ("claude-sonnet-4-0", Price::new(3.0, 15.0, 0.30)),
    ("claude-sonnet-4", Price::new(3.0, 15.0, 0.30)),
];

/// Claude Haiku 5.5 costs more for prompts over 100K tokens ($0.50 / $2.50). The
/// long-prompt cache read price isn't published; we assume the usual 0.1x input.
const HAIKU_5_5_LONG: Price = Price::new(0.50, 2.50, 0.05);
const HAIKU_5_5_LONG_THRESHOLD: u64 = 100_000;

/// Reduce a model id to the name used in the price table. Drops a platform
/// prefix (`anthropic.`, `us.anthropic.`), a `[1m]` marker, a Bedrock version
/// suffix (`-v1:0`), and a date snapshot (`-20251001` or `@20251001`).
pub fn canonical_model(model: &str) -> &str {
    let mut m = model.trim();
    if let Some(i) = m.rfind("anthropic.") {
        m = &m[i + "anthropic.".len()..];
    }
    if let Some(i) = m.find(['[', '@']) {
        m = &m[..i];
    }
    if let Some((head, tail)) = m.rsplit_once("-v") {
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit() || b == b':') {
            m = head;
        }
    }
    if let Some((head, tail)) = m.rsplit_once('-') {
        if tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit()) {
            m = head;
        }
    }
    m
}

/// Price for one request, or `None` for a model we don't know.
pub fn price_for(model: &str, prompt_tokens: u64) -> Option<Price> {
    let model = canonical_model(model);
    if model == "claude-haiku-5-5" && prompt_tokens > HAIKU_5_5_LONG_THRESHOLD {
        return Some(HAIKU_5_5_LONG);
    }
    PRICES
        .iter()
        .find(|(id, _)| *id == model)
        .map(|(_, price)| *price)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_model_strips_noise() {
        assert_eq!(canonical_model("claude-opus-5-5"), "claude-opus-5-5");
        assert_eq!(canonical_model("claude-opus-5-5[1m]"), "claude-opus-5-5");
        assert_eq!(
            canonical_model("claude-haiku-4-5-20251001"),
            "claude-haiku-4-5"
        );
        assert_eq!(
            canonical_model("anthropic.claude-sonnet-5-5"),
            "claude-sonnet-5-5"
        );
        // a version digit is not a date
        assert_eq!(canonical_model("claude-opus-5"), "claude-opus-5");
        for id in [
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
            "claude-sonnet-4-5@20250929",
            "claude-sonnet-4-5-20250929",
        ] {
            assert_eq!(canonical_model(id), "claude-sonnet-4-5", "{id}");
            assert!(price_for(id, 0).is_some());
        }
    }

    #[test]
    fn haiku_5_5_long_prompt_tier() {
        assert_eq!(price_for("claude-haiku-5-5", 1_000).unwrap().input, 0.10);
        assert_eq!(price_for("claude-haiku-5-5", 150_000).unwrap().input, 0.50);
    }

    #[test]
    fn unknown_model_has_no_price() {
        assert!(price_for("gpt-5", 10).is_none());
        assert!(price_for("<synthetic>", 0).is_none());
    }
}
