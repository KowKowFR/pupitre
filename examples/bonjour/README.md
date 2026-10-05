# Example — an application deployed from its repository

A static page served by nginx, built on the target machine from the
repository's code. It is there to see repository tracking end to end.

In Pupitre: **Applications → New application → From a repository**, then this
repository and its branch. The `examples/bonjour/pupitre.json` file is found by
itself; only changes under `examples/bonjour/` concern the application, the rest
of the repository does not touch it.

On each new commit, as you choose:

- **update the application**: the new version waits for you to deploy it,
  wherever you want;
- **redeploy it where it runs**.

The status is sent back to the commit on GitHub.

The image runs with the hardening Pupitre applies to everything it builds from
your code — read-only root, unprivileged user, no capability — hence the
`nginx-unprivileged` base on port 8080.
