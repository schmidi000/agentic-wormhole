module.exports = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits"
      }
    ],
    [
      "@semantic-release/release-notes-generator",
      {
        preset: "conventionalcommits"
      }
    ],
    [
      "@semantic-release/changelog",
      {
        changelogFile: "CHANGELOG.md"
      }
    ],
    [
      "@semantic-release/npm",
      {
        pkgRoot: "server",
        tarballDir: "dist/npm"
      }
    ],
    [
      "@semantic-release/github",
      {
        assets: ["dist/npm/*.tgz"]
      }
    ],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "server/package.json", "package-lock.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }
    ]
  ]
};
