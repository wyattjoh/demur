# Releasing

Releases are managed by [release-please](https://github.com/googleapis/release-please).
It opens a release pull request from Conventional Commits, updates
`package.json` and `CHANGELOG.md`, and creates a GitHub release and tag when that
pull request is merged. The same workflow then publishes the package to npm.

## One-time npm bootstrap

npm Trusted Publishing cannot create a new package. Publish `0.1.0` once with
normal npm authentication before enabling OIDC:

1. Confirm the checkout is on the public branch and clean.
2. Sign in with an npm account that owns the `@wyattjoh` scope:

   ```sh
   npm login
   npm whoami
   ```

3. Inspect the exact package contents:

   ```sh
   npm pack --dry-run
   ```

4. Publish the initial public package. `prepublishOnly` runs the full CI gate:

   ```sh
   npm publish --access public
   ```

5. In the npm settings for `@wyattjoh/demur`, add a GitHub Actions trusted
   publisher with these exact values:

   - organization or user: `wyattjoh`
   - repository: `demur`
   - workflow filename: `release.yml`
   - environment: leave blank

6. Create the matching initial Git tag and GitHub release if they do not exist:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   gh release create v0.1.0 --title "v0.1.0" --generate-notes
   ```

After the trusted publisher is configured, no `NPM_TOKEN` is needed. The
release workflow requests a short-lived OIDC token with `id-token: write`, and
npm attaches provenance automatically for this public repository.

## Normal releases

Use Conventional Commits on `main`:

- `fix:` proposes a patch release.
- `feat:` proposes a minor release while the project is pre-1.0.
- `feat!:` or a `BREAKING CHANGE:` footer proposes a minor release while the
  project is pre-1.0.
- Other commit types do not trigger a release by default.

release-please creates or updates a release pull request after qualifying
commits land on `main`. Review its version and changelog, then merge it. The
workflow creates the tag and GitHub release, reruns `bun run ci`, and publishes
the new npm version.

Release pull requests created with `GITHUB_TOKEN` do not trigger the separate PR
CI workflow. The release workflow therefore repeats the full quality gate before
publishing.

## Repository setting

GitHub Actions must be allowed to create pull requests. In GitHub, enable:

**Settings → Actions → General → Workflow permissions → Allow GitHub Actions to
create and approve pull requests**
