// Names as people read them. Anyone can call an organisation anything, so a
// name that reads like another's is treated as the same name wherever the
// two are compared: differing only in case or spacing, in the form of a
// letter (fullwidth, say), or in a letter of another script that looks the
// same.

/** Letters of Cyrillic and Greek that are drawn like a Latin one, and the Latin one. */
const LOOKALIKES: Record<string, string> = {
  // Cyrillic
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", Ѕ: "S", І: "I", Ј: "J",
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", ѕ: "s", і: "i", ј: "j", һ: "h", ԁ: "d", ԛ: "q", ԝ: "w",
  // Greek
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
  ο: "o", ν: "v", ι: "i", κ: "k", ρ: "p",
};

/**
 * What a name reads as: the same for two names a person would take for one
 * another. A capital I, a small l and the digit 1 read alike, as do O and 0.
 */
export function reads(name: string): string {
  return Array.from(name.normalize("NFKC"), (letter) => LOOKALIKES[letter] ?? letter)
    .join("")
    .replace(/[I1|]/g, "l")
    .toLowerCase()
    .replace(/0/g, "o")
    .replace(/\s+/g, " ")
    .trim();
}
