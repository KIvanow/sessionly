//! API list prices, used to estimate cost from token counts: for Claude Code
//! when a transcript has no recorded total (a session that is still running,
//! or one that crashed), and for Codex and Cursor, which record no cost.
//!
//! Prices are USD per million tokens. Anthropic's cache writes cost 1.25x
//! input (5-minute TTL) or 2x input (1-hour TTL); cache reads vary by model.
//! Checked against Claude Code's own `cost-state` totals. OpenAI lists its
//! write prices per model (30-minute and 12-hour lifetimes) and bills
//! reasoning tokens as output.

/// Per-million-token prices for one model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// Cache writes with a short lifetime and with a long one. `None` where
    /// the price list gives no write price: what is written is then taken
    /// to cost what input does, as it would have without the cache.
    pub cache_write: Option<(f64, f64)>,
}

/// The tokens of one request, or of several billed alike, each counted once:
/// `input` is the uncached input only, `output` includes reasoning tokens.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Billed {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    /// Written to a short-lived cache: 5 minutes at Anthropic, 30 at OpenAI.
    pub cache_write_short: u64,
    /// Written to a long-lived cache: 1 hour at Anthropic, 12 at OpenAI.
    pub cache_write_long: u64,
}

impl Price {
    /// Anthropic's: cache writes at 1.25x and 2x input.
    const fn new(input: f64, output: f64, cache_read: f64) -> Self {
        Price {
            input,
            output,
            cache_read,
            cache_write: Some((input * 1.25, input * 2.0)),
        }
    }

    /// As a price list gives it: input, cached input, output, and the two
    /// write prices where it has them.
    const fn listed(input: f64, cached: f64, output: f64, writes: Option<(f64, f64)>) -> Self {
        Price {
            input,
            output,
            cache_read: cached,
            cache_write: writes,
        }
    }

    /// OpenAI's price for a long prompt: input, cached input and cache
    /// writes at twice this, output at 1.5x.
    fn long(&self) -> Self {
        Price {
            input: self.input * 2.0,
            output: self.output * 1.5,
            cache_read: self.cache_read * 2.0,
            cache_write: self
                .cache_write
                .map(|(short, long)| (short * 2.0, long * 2.0)),
        }
    }

    /// What `tokens` cost in USD.
    pub fn cost(&self, tokens: &Billed) -> f64 {
        let (short, long) = self.cache_write.unwrap_or((self.input, self.input));
        (tokens.input as f64 * self.input
            + tokens.output as f64 * self.output
            + tokens.cache_read as f64 * self.cache_read
            + tokens.cache_write_short as f64 * short
            + tokens.cache_write_long as f64 * long)
            / 1e6
    }
}

/// Changes whenever the tables below do, so stored estimates can be rebuilt.
pub const PRICING_VERSION: &str = "2026-11";

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
    // OpenAI, Standard tier, from https://developers.openai.com/api/docs/pricing
    // (what platform.openai.com/docs/pricing redirects to), read 2026-11-20:
    // input, cached input, output, then the 30-minute and 12-hour write
    // prices. Where the page shows no write price there is none here, and what
    // a request wrote to the cache is charged at the input price. Models the
    // page does not list (gpt-5.1-codex and the like) have no price.
    (
        "gpt-6.2-astra",
        Price::listed(8.0, 0.40, 40.0, Some((10.0, 20.0))),
    ),
    (
        "gpt-6.2-sol",
        Price::listed(2.0, 0.10, 10.0, Some((2.50, 5.0))),
    ),
    (
        "gpt-6-astra",
        Price::listed(10.0, 1.00, 50.0, Some((12.50, 25.0))),
    ),
    (
        "gpt-6.1-sol",
        Price::listed(2.0, 0.10, 10.0, Some((2.50, 5.0))),
    ),
    (
        "gpt-6.1-terra",
        Price::listed(1.0, 0.05, 5.0, Some((1.25, 2.50))),
    ),
    (
        "gpt-6-sol",
        Price::listed(2.0, 0.20, 10.0, Some((2.50, 5.0))),
    ),
    (
        "gpt-6-luna",
        Price::listed(0.10, 0.01, 0.50, Some((0.125, 0.25))),
    ),
    (
        "gpt-5.6-sol",
        Price::listed(4.0, 0.40, 20.0, Some((5.0, 10.0))),
    ),
    (
        "gpt-5.6-terra",
        Price::listed(2.0, 0.20, 12.0, Some((2.50, 5.0))),
    ),
    (
        "gpt-5.6-luna",
        Price::listed(0.20, 0.02, 1.20, Some((0.25, 0.50))),
    ),
    ("gpt-5.5", Price::listed(5.0, 0.50, 30.0, None)),
    ("gpt-5.4", Price::listed(2.50, 0.25, 15.0, None)),
    ("gpt-5.4-mini", Price::listed(0.75, 0.075, 4.50, None)),
    ("gpt-5.4-nano", Price::listed(0.20, 0.02, 1.25, None)),
    ("gpt-5.3-codex", Price::listed(1.75, 0.175, 14.0, None)),
    ("gpt-5.2", Price::listed(1.75, 0.175, 14.0, None)),
    ("gpt-5.1", Price::listed(1.25, 0.125, 10.0, None)),
    ("gpt-5", Price::listed(1.25, 0.125, 10.0, None)),
    ("gpt-5-mini", Price::listed(0.25, 0.025, 2.0, None)),
    ("gpt-5-nano", Price::listed(0.05, 0.005, 0.40, None)),
    // Cursor's own, from https://cursor.com/docs/models (per million, as
    // https://cursor.com/blog/composer-2-5 says), read 2026-11-20. The page
    // gives no cache write price.
    ("composer-2.5", Price::listed(0.50, 0.20, 2.50, None)),
    ("composer-2.5-fast", Price::listed(3.0, 0.50, 15.0, None)),
];

/// Claude Haiku 5.5 over 100K prompt tokens: 5x. The long-prompt cache read
/// price isn't published; we assume the usual 0.1x input.
const HAIKU_5_5_LONG: (u64, Price) = (100_000, Price::new(0.50, 2.50, 0.05));

/// OpenAI's models with a price for long prompts, from the same page as
/// above: over 272K input tokens, the whole request costs twice the input,
/// cached input and cache write prices and 1.5x the output price (see
/// `Price::long`). The others have one price at any length.
const OPENAI_LONG: (u64, &[&str]) = (
    272_000,
    &[
        "gpt-6.2-astra",
        "gpt-6.2-sol",
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-6.1-terra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
        "gpt-5.4",
    ],
);

/// A reasoning effort some clients add to a model's name (Cursor's
/// `gpt-5.3-codex-high`). It does not change the price per token.
const EFFORTS: &[&str] = &["-minimal", "-low", "-medium", "-high", "-xhigh"];

/// Reduce a model id to the name used in the price table. Drops a provider
/// prefix (`openai/`, `anthropic.`, `us.anthropic.`), a `[1m]` marker, a
/// Bedrock version suffix (`-v1:0`), a date snapshot (`-20251001`,
/// `@20251001`, OpenAI's `-2026-03-05`) and a reasoning effort (`-high`).
/// A `-fast` stays: that is billed differently, or is a model of its own.
pub fn canonical_model(model: &str) -> &str {
    let mut m = model.trim();
    if let Some(i) = m.rfind('/') {
        m = &m[i + 1..];
    }
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
    if let Some(effort) = EFFORTS.iter().find(|e| m.ends_with(*e)) {
        m = &m[..m.len() - effort.len()];
    }
    if let Some((head, tail)) = m.rsplit_once('-') {
        if tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit()) {
            m = head;
        }
    }
    // -YYYY-MM-DD
    if let Some(head) = m.len().checked_sub(11).and_then(|i| {
        let (head, tail) = m.split_at_checked(i)?;
        let b = tail.as_bytes();
        let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
        (b[0] == b'-'
            && b[5] == b'-'
            && b[8] == b'-'
            && digits(1..5)
            && digits(6..8)
            && digits(9..11))
        .then_some(head)
    }) {
        m = head;
    }
    m
}

/// Price for one request, or `None` for a model we don't know.
/// `prompt_tokens` is all of its input, cached or not.
pub fn price_for(model: &str, prompt_tokens: u64) -> Option<Price> {
    let model = canonical_model(model);
    if model == "claude-haiku-5-5" && prompt_tokens > HAIKU_5_5_LONG.0 {
        return Some(HAIKU_5_5_LONG.1);
    }
    let (threshold, long) = OPENAI_LONG;
    let (_, price) = PRICES.iter().find(|(id, _)| *id == model)?;
    Some(if prompt_tokens > threshold && long.contains(&model) {
        price.long()
    } else {
        *price
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

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
            "anthropic/claude-sonnet-4-5",
        ] {
            assert_eq!(canonical_model(id), "claude-sonnet-4-5", "{id}");
            assert!(price_for(id, 0).is_some());
        }
    }

    #[test]
    fn canonical_model_knows_openai_and_codex_ids() {
        for (id, want) in [
            ("gpt-6-luna", "gpt-6-luna"),
            ("gpt-6.1-sol", "gpt-6.1-sol"),
            ("openai/gpt-6.1-sol", "gpt-6.1-sol"),
            ("gpt-6.1-sol-2026-09-30", "gpt-6.1-sol"),
            ("openai/gpt-5.4-2026-03-05", "gpt-5.4"),
            (" gpt-6-luna ", "gpt-6-luna"),
            ("gpt-5.3-codex-high", "gpt-5.3-codex"),
            ("gpt-5.3-codex-xhigh", "gpt-5.3-codex"),
            ("gpt-5-mini", "gpt-5-mini"),
            ("composer-2.5-fast", "composer-2.5-fast"),
            // billed differently: kept, and so unpriced
            ("gpt-5-high-fast", "gpt-5-high-fast"),
        ] {
            assert_eq!(canonical_model(id), want, "{id}");
        }
        for id in [
            "openai/gpt-6.1-sol",
            "gpt-6-luna-2026-08-01",
            "gpt-5.3-codex-high",
        ] {
            assert!(price_for(id, 0).is_some(), "{id}");
        }
        // a dated id whose base is not listed is not taken for another
        assert!(price_for("gpt-5.1-codex-2026-01-01", 0).is_none());
        assert!(price_for("gpt-5-high-fast", 0).is_none());
    }

    #[test]
    fn openai_prices_per_model() {
        let p = price_for("gpt-6-luna", 0).unwrap();
        assert_eq!((p.input, p.cache_read, p.output), (0.10, 0.01, 0.50));
        assert_eq!(p.cache_write, Some((0.125, 0.25)));
        let p = price_for("gpt-6.1-sol", 0).unwrap();
        assert_eq!((p.input, p.cache_read, p.output), (2.0, 0.10, 10.0));
        let p = price_for("gpt-5.3-codex", 0).unwrap();
        assert_eq!((p.input, p.cache_read, p.output), (1.75, 0.175, 14.0));
        let p = price_for("composer-2.5-fast", 0).unwrap();
        assert_eq!((p.input, p.cache_read, p.output), (3.0, 0.50, 15.0));
    }

    #[test]
    fn long_prompts_cost_more() {
        assert_eq!(price_for("claude-haiku-5-5", 1_000).unwrap().input, 0.10);
        assert_eq!(price_for("claude-haiku-5-5", 150_000).unwrap().input, 0.50);
        assert_eq!(price_for("gpt-6.1-sol", 272_000).unwrap().input, 2.0);
        let long = price_for("gpt-6.1-sol", 272_001).unwrap();
        assert_eq!(
            (long.input, long.cache_read, long.output),
            (4.0, 0.20, 15.0)
        );
        // no long tier listed: the one price
        assert_eq!(price_for("gpt-5.3-codex", 900_000).unwrap().input, 1.75);
        assert_eq!(price_for("composer-2.5-fast", 900_000).unwrap().input, 3.0);
    }

    #[test]
    fn long_prompt_prices_are_those_openai_lists() {
        // as the page gives them: input, cached input, output, and the two writes
        let long = |model: &str| {
            let p = price_for(model, 272_001).unwrap();
            (p.input, p.cache_read, p.output, p.cache_write)
        };
        assert_eq!(
            long("gpt-6.2-astra"),
            (16.0, 0.80, 60.0, Some((20.0, 40.0)))
        );
        assert_eq!(long("gpt-6-luna"), (0.20, 0.02, 0.75, Some((0.25, 0.50))));
        assert_eq!(long("gpt-5.4"), (5.0, 0.50, 22.50, None));
        // every model with a long price has a short one to take it from
        for model in OPENAI_LONG.1 {
            assert!(PRICES.iter().any(|(id, _)| id == model), "{model}");
        }
    }

    #[test]
    fn cost_counts_each_kind_of_token_at_its_price() {
        let p = price_for("gpt-6.1-sol", 0).unwrap();
        let tokens = Billed {
            input: 1_000_000,
            output: 100_000,
            cache_read: 2_000_000,
            cache_write_short: 10_000,
            cache_write_long: 1_000,
        };
        // 2.00 + 1.00 + 0.20 + 0.025 + 0.005
        assert!(close(p.cost(&tokens), 3.23));
        // Anthropic's writes are a multiple of input
        let opus = price_for("claude-opus-5", 0).unwrap();
        let writes = Billed {
            cache_write_short: 1_000_000,
            cache_write_long: 1_000_000,
            ..Default::default()
        };
        assert!(close(opus.cost(&writes), 6.25 + 10.0));
    }

    #[test]
    fn writes_without_a_write_price_cost_what_input_does() {
        let p = price_for("gpt-5.4", 0).unwrap();
        let wrote = Billed {
            cache_write_short: 1_000_000,
            cache_write_long: 1_000_000,
            ..Default::default()
        };
        assert!(close(p.cost(&wrote), 2.50 + 2.50));
    }

    #[test]
    fn unknown_model_has_no_price() {
        assert!(price_for("gpt-9", 10).is_none());
        assert!(price_for("gpt-5.1-codex", 10).is_none());
        assert!(price_for("<synthetic>", 0).is_none());
    }
}
