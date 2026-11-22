# Release notes

The notes for each GitHub release, written by hand. The release workflow
(`.github/workflows/release.yml`) reads `<tag>.md` for the tag it publishes,
such as `v0.7.1.md`, and appends `install.md` to it. A release without its
`<tag>.md` gets GitHub's generated notes instead, with `install.md` still
appended, and the workflow prints a warning naming the file to add.
