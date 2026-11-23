//! How many findings a review's reply says it has: read on the machine, and
//! only the number kept. A guess at a few known wordings, where not knowing
//! is the safe side: a reply worded another way has no count.

use serde_json::Value;

/// How far into a reply its number of findings is looked for: its first lines.
const FINDINGS_WITHIN: usize = 400;

/// How many findings a review's reply says it has, where its first lines say
/// so in a way that can be relied on: a JSON list of them, or a number of
/// findings, issues, problems or bugs that the reply opens a sentence with or
/// says it found, kept or has ("15 findings, most severe first", "I reviewed
/// PR #50 and found 4 issues", "there are no findings"). Read here on the
/// machine; only the number is kept.
///
/// None when the reply words it another way, and when it is not clear which
/// number is meant: "the two earlier findings are fixed" counts nothing, two
/// different numbers are none unless one is what was kept, and none of one
/// kind ("no blocking bugs", "no bugs that crash anything", "no bugs found,
/// but 3 style issues", "No issues. However, two nits.") is not none at all.
pub fn findings_in(reply: &str) -> Option<u64> {
    let reply = reply.trim();
    if let Some(block) = reply.strip_prefix("```json") {
        let list = block.rsplit_once("```").map_or(block, |(list, _)| list);
        return match serde_json::from_str::<Value>(list.trim()).ok()? {
            Value::Array(found) => Some(found.len() as u64),
            _ => None,
        };
    }
    const THINGS: &[&str] = &[
        "finding", "findings", "issue", "issues", "problem", "problems", "bug", "bugs",
    ];
    // What says that the number after it is this review's.
    const FRAMES: &[&str] = &[
        "found",
        "kept",
        "keeping",
        "are",
        "is",
        "has",
        "have",
        "with",
        "reports",
        "reporting",
    ];
    const NOT_A_KIND: &[&str] = &["of", "the", "in", "and", "or", "to", "for", "on", "from"];
    const WORDS: &[&str] = &[
        "no",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
    ];
    let head: String = reply.chars().take(FINDINGS_WITHIN).collect();
    let raw: Vec<&str> = head.split_whitespace().collect();
    let clean = |word: &str| {
        word.trim_matches(|c: char| !c.is_alphanumeric())
            .to_ascii_lowercase()
    };
    let number = |word: &str| -> Option<u64> {
        if word.starts_with('#') {
            return None;
        }
        let word = clean(word);
        match WORDS.iter().position(|w| *w == word) {
            Some(n) => Some(n as u64),
            None => word.parse().ok().filter(|_| word.len() <= 4),
        }
    };
    let (mut kept, mut counts): (Vec<u64>, Vec<u64>) = (Vec::new(), Vec::new());
    for (i, word) in raw.iter().enumerate() {
        if !THINGS.contains(&clean(word).as_str()) || i == 0 {
            continue;
        }
        // "4 issues", or with what kind between: "4 blocking issues".
        let at = match number(raw[i - 1]) {
            Some(_) => i - 1,
            None if i >= 2 && !NOT_A_KIND.contains(&clean(raw[i - 1]).as_str()) => i - 2,
            None => continue,
        };
        let Some(count) = number(raw[at]) else {
            continue;
        };
        // None of a kind says nothing of the other kinds, and nor does
        // none that is then narrowed ("no bugs that block it", "no bugs
        // found, but several smaller problems").
        if count == 0 && (at != i - 1 || narrowed(&raw, i)) {
            continue;
        }
        let before = at.checked_sub(1).map(|b| raw[b]);
        let frame = before.map(clean).unwrap_or_default();
        let opens = before.is_none_or(|b| b.ends_with(['.', ':', '!', '?']));
        if frame == "kept" || frame == "keeping" {
            kept.push(count);
        } else if opens || FRAMES.contains(&frame.as_str()) {
            counts.push(count);
        }
    }
    let one = |of: &[u64]| of.first().copied().filter(|n| of.iter().all(|m| m == n));
    one(&kept).or_else(|| one(&counts).filter(|_| kept.is_empty()))
}

/// True where the none said of the noun at `i` ("no bugs") is then narrowed:
/// by the word straight after it, by one further on in its sentence, or by
/// the word the next sentence opens with.
fn narrowed(raw: &[&str], i: usize) -> bool {
    // Straight after "no bugs": what makes it none of some, not none at all.
    const STRAIGHT: &[&str] = &["that", "which", "worth", "of"];
    // The same anywhere in the rest of the sentence ("no bugs found, but 3
    // style issues"), and as what the next one opens with ("No issues.
    // However, two nits.").
    const LATER: &[&str] = &[
        "but",
        "except",
        "beyond",
        "other",
        "apart",
        "aside",
        "though",
        "although",
        "however",
        "only",
        "just",
        "besides",
        "save",
        "exception",
        "far",
        "yet",
        "still",
    ];
    // Short forms that end in a full stop and end no sentence.
    const SHORT: &[&str] = &["e.g.", "i.e.", "etc.", "vs."];
    // A word may have another stuck to it ("found,but").
    let parts = |word: &str| -> Vec<String> {
        word.split(|c: char| !c.is_alphanumeric())
            .filter(|part| !part.is_empty())
            .map(str::to_ascii_lowercase)
            .collect()
    };
    let ends = |word: &str| {
        let word = word.trim_end_matches(['"', '\'', ')', '*', '_', '`', '”', '’']);
        let short = word.trim_start_matches(['(', '"']).to_ascii_lowercase();
        // "found... but" goes on.
        word.ends_with(['.', '!', '?']) && !word.ends_with("..") && !SHORT.contains(&short.as_str())
    };
    let last = (i..raw.len())
        .find(|at| ends(raw[*at]))
        .unwrap_or(raw.len() - 1);
    let rest = &raw[i + 1..=last];
    let first = |word: &&str| parts(word).into_iter().next();
    let is = |of: &[&str], word: Option<String>| word.is_some_and(|w| of.contains(&w.as_str()));
    is(STRAIGHT, rest.first().and_then(first))
        || rest
            .iter()
            .flat_map(|word| parts(word))
            .any(|w| LATER.contains(&w.as_str()))
        || is(LATER, raw.get(last + 1).and_then(first))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_says_how_many_findings_in_a_few_known_ways() {
        assert_eq!(
            findings_in("```json\n[{\"file\":\"a.rs\"},{\"file\":\"b.rs\"}]\n```"),
            Some(2)
        );
        assert_eq!(findings_in("```json\n[]\n```"), Some(0));
        assert_eq!(findings_in("```json\n{\"ok\":true}\n```"), None);
        assert_eq!(findings_in("I found 3 issues in PR #50."), Some(3));
        assert_eq!(findings_in("I found no problems in the diff."), Some(0));
        assert_eq!(
            findings_in("15 findings, most severe first:\n\n1. ..."),
            Some(15)
        );
        assert_eq!(findings_in("No findings."), Some(0));
        // further into the first lines, said as found, kept or had
        for (reply, n) in [
            ("I reviewed PR #50 at high effort and found 4 issues.", 4),
            (
                "I reviewed PR 12 (`feat/x`, 9 files). There are 7 findings.",
                7,
            ),
            (
                "Review of PR #3 is done. Ten findings, most severe first.",
                10,
            ),
            ("I reviewed 14 files and found 3 confirmed problems.", 3),
            ("PR #77 has no issues.", 0),
            ("Of 20 candidates I verified each and kept 5 findings.", 5),
            (
                "I found 9 issues and, after checking each, kept 6 findings.",
                6,
            ),
        ] {
            assert_eq!(findings_in(reply), Some(n), "{reply}");
        }
        // None, and the sentence is over: what a later one says of other
        // things narrows nothing.
        for none in [
            "No issues found. The other files are fine.",
            "No issues. The other files are fine, though.",
            "**No issues found.** The other files are fine too.",
            "No issues found (e.g. in the parser). The rest is fine, but slow.",
            "I reviewed PR #9 and found no bugs.",
            "No issues",
        ] {
            assert_eq!(findings_in(none), Some(0), "{none}");
        }
        for other in [
            "I reviewed PR #50 at high effort and 3 things stand out.",
            "I found the 2 callers.",
            "2026 was a long year",
            // another review's findings
            "The two earlier findings are fixed.",
            "Both of the 3 issues from the last round are gone.",
            // two numbers, and nothing says which
            "I found 3 issues in the server. The CLI has 2 problems.",
            // a pull request's number is no count
            "This closes #12 issues aside.",
            // none of one kind is not none at all
            "PR #77 has no blocking bugs.",
            "I reviewed PR 740 and found no bugs that would block it. There are four smaller ones.",
            "I found no bugs, but the diff has several minor issues.",
            "There are no issues of substance.",
            "I found no blocking bugs, but the diff has several minor issues.",
            // narrowed further on in the sentence
            "No bugs found, but 3 style issues.",
            "No issues found other than two style nits.",
            "I found no problems in the diff, except for a typo in the README.",
            "There are no bugs here, though the tests are thin.",
            "No issues found (apart from the naming)!",
            "No issues found though.",
            "No bugs found, only 3 style nits.",
            "No bugs found; just two nits.",
            "No issues found besides a typo.",
            "No issues found, save for a typo.",
            "No bugs found, with the exception of a typo.",
            "No bugs found so far, still 3 files to go.",
            "No issues found yet; still reviewing.",
            // with no space before the word
            "No bugs found,but 3 nits.",
            // a full stop that ends no sentence
            "No bugs found, e.g. nothing crashed, but 3 style issues remain.",
            "No bugs found... but 3 nits",
            // narrowed by what the next sentence opens with
            "No issues. However, I found 2 nits.",
            "No bugs. But the tests are thin.",
            "I found no issues. Though the naming is off, that is a nit.",
            "There are no findings. Other than that, CI is red.",
            "No bugs.\n\nHowever, several style problems remain.",
            "\"No bugs found.\" But 3 issues",
            "",
        ] {
            assert_eq!(findings_in(other), None, "{other}");
        }
    }
}
