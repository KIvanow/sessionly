# Sessionly documentation

The pages of [docs.sessionly.dev](https://docs.sessionly.dev): one Markdown file a page, built
with [Jekyll](https://jekyllrb.com) and the [Just the Docs](https://just-the-docs.com) theme.
The Docs workflow (`.github/workflows/docs.yml`) builds and publishes them to GitHub Pages
when a change here reaches `main`.

## Preview

With Ruby 3.1 or later:

```sh
cd docs-site
bundle config set --local path vendor/bundle
bundle install
bundle exec jekyll serve      # http://127.0.0.1:4000
```

## Writing a page

- A page starts with its title and its place in the menu:

  ```yaml
  ---
  title: Shell edits
  nav_order: 3
  parent: Command line     # leave out for a page at the top of the menu
  ---
  ```

  A page that has pages under it also says `has_children: true`.
- Link to another page by its file name, `[Install](install.md)`, so that the link also works
  when the file is read on GitHub. The build turns it into the page's address.
- Link to a file of the repository by its full address
  (`https://github.com/KIvanow/sessionly/blob/main/…`): the site has only this folder.
- Say what the code does. A number, a default or a file name in a page should be one you can
  point to in the source.

This file is not a page of the site.
