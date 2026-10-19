# Documentation and publication

README, `docs/adaptive-engineering.md`, and `docs/migration/ae.md` are the authoring sources. The Pages workflow copies them into Jekyll pages through `scripts/build-docs.mjs`; it does not maintain another explanation. The repository identity and Pages base path come from the workflow context, so the later rename does not require another site fork.

Pull requests build a site artifact. To publish after acceptance, enable Pages with the GitHub Actions source and run the **Documentation** workflow with publication selected. Review the deployment environment before the first run. See [GitHub's custom workflow instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Enable the Wiki when the owner is ready. Its Home page should link to the README, concept and migration guide. Put short recipes and discussions there; link to the maintained source for contracts and installation instructions. Wiki edits are a separate Git repository and are not included in a normal pull request. This migration does not write or duplicate the existing Wiki.

The **AE package candidate** workflow retains the exact archive, npm integrity record and SHA-256 file for each operating system. Download the Linux archive for release qualification and keep its bytes through the installation, native editor and rollback runs. The Windows artifact is available for the user's later native editor test. Automated installation does not establish editor acceptance.

Before publication, the owner selects license terms, verifies control of `ae-harness`, and configures npm publishing authentication or a trusted publisher for the final repository identity. Keep `UNLICENSED` until that decision is made. Update package repository/homepage metadata after the user performs the GitHub rename. Do not publish a qualified archive whose embedded metadata needs an edit; build and qualify the replacement instead.

After qualification, publish the same archive with `npm publish <archive.tgz> --access public`; do not repack between qualification and publication. Create the matching version tag and GitHub release with the same archive, checksum and qualification notes. State native platform gaps. `npm view ae-harness@<version> dist.integrity` must match the packed integrity. Compare the downloaded registry archive with the qualified SHA-256 before announcing it. Release creation and npm publication remain owner actions; this change only prepares candidates.
