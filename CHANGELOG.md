# Changelog

## Unreleased (this fork)

- Claim the fork's own identity: `package.json` now carries `author`, `repository`, `homepage` and `bugs` pointing at `Kerwin0224/skill-shelf-magpie-plugin`, and the in-plugin **GitHub** button (`src/plugin.mjs`) opens this repository instead of the upstream one.
- README (zh/en) install commands and the signature line now name this fork and credit the upstream author.
- Version stays at **0.1.14**: the number tracks the upstream desktop feature baseline recorded in `FEATURE_PARITY.md`, not the fork's own release numbering.

## 0.1.14 - 2026-10-15

- Align the plugin's core feature baseline with Skill Shelf desktop 0.1.14; the matching version is not a claim of complete desktop parity.
- Restore skills.sh discovery, rankings, search and details, with confirmed global/project source installation and previewed removal. Use the pinned Skills CLI in an isolated staging directory and refuse to overwrite existing installations.
- Add the dedicated Agent access workspace with expiring previews, managed links and copies, manual copy updates, link repair, disconnection, external ownership protection and recovery notices.
- Share the desktop Agent registry and direct-reader rules across scanning, installation and access management.
- Match shared UI wording and entry positions: use “同步”, order navigation as Workbench / Skills / Discover / Packs, use the desktop Compass icon and discovery category hierarchy, and route “添加 Skill” to discovery.
- Add project AGENTS.md and CLAUDE.md editing, original-file backups, revision checks and Claude imports.
- Export single Packs in the desktop metadata v5 format, preview their import and retain legacy plugin Pack import support. Preserve portable preferences, custom descriptions and folder/Pack view options in synchronization.
- Keep quiet startup and Magpie's existing model integration. Document remaining terminal, localization and desktop/host differences in FEATURE_PARITY.md.

## 0.1.1 - 2026-10-12

- Start the Magpie plugin quietly by default, without opening a browser on startup, restart or background workbench recovery.
- Keep the manual Skill Shelf launch actions available. Automatic browser opening now requires an explicit `open: true`.
- Update both language guides and add real Magpie host regression coverage for default, disabled and opted-in browser opening.
