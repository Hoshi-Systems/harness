# Prerelease artifacts

Harness is not published to npm yet. Until it is, another repository can either
pin a source commit during development or consume an immutable GitHub Release
asset without copying its source.

For development before an artifact exists, a consumer may pin a full Git commit
with `github:Hoshi-Systems/harness#<commit>`. The repository's `prepare` script
builds its `dist` during that installation. This is a temporary development
bridge: never pin a branch or a moving tag, because a plugin and its daemon
must resolve exactly one Harness module instance.

## Create an artifact

1. Update `version` in `package.json` to the intended prerelease version.
2. Run **Release artifact** from the repository's Actions tab on the commit to
   release.
3. The workflow runs the complete package check, packs `dist`, and creates a
   prerelease named `v<package-version>` with the `.tgz` attached.

The workflow refuses to replace an existing release tag. A release asset is
therefore an immutable record of its source commit and package version.

## Consume an artifact

A product that embeds Harness pins the full release-asset URL in its package
manifest rather than a branch, tag name, or local source path. Its extension
packages must declare Harness as a peer dependency, so their imports resolve to
the daemon's one installed module instance.

Do not install from a moving Git branch: two packages resolving different
commits can each create a plugin registry, while only one is served by the
daemon. Do not copy `src` into the consuming repository either; that makes the
public package stale the moment the two copies diverge.

This bridge is intentionally temporary. A public npm release replaces the
asset URL once release policy, support expectations, and semver guarantees are
ready.
