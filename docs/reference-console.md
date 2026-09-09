# Reference Console

Reference Console is a deliberately small, read-only client of the Harness
Capability Passport. It answers one operator question: *what can this machine
do right now?* It renders the capability owner, readiness, registered routes
and tools, plus declared system and kernel-port requirements.

It is an example client, not a daemon feature and not a Hoshi product surface.
The console has no package install, no backend, no local persistence, and no
write controls. Its existence proves that the public Passport is useful without
bringing product UI, organization policy, or a marketplace into Harness.

## Run locally

Start a Harness daemon, then serve the console in a second terminal:

```sh
hoshi-harness serve --host 127.0.0.1 --port 4200
pnpm console
```

Open `http://127.0.0.1:4876`, enter `http://127.0.0.1:4200` and an owner bearer
token, and choose **Inspect machine**. The console calls only
`GET /capabilities` with the token in an `Authorization` header. It never puts a
token in a URL, browser storage, or a log, and clears the form field after each
request.

## Connect to another origin

In development the Harness accepts loopback origins. A production daemon fails
closed for browser origins, so its operator must include the console origin in
`CORS_ORIGINS` before connecting it:

```sh
CORS_ORIGINS=http://127.0.0.1:4876 hoshi-harness serve --port 4200
```

Use a separate origin for every console deployment and keep the allowlist as
narrow as possible. CORS permits a browser request; the owner bearer still
authenticates the Passport request.

## What it intentionally does not do

- It does not authorize routes or tools. Capability readiness is descriptive.
- It does not install, configure, enable, or disable plugins.
- It does not replace a product's machine UI.
- It does not expose credentials, filesystem paths, commands, raw logs, or
  thrown errors; the Passport contract excludes them before the console sees a
  response.
