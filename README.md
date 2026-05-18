# @alembic/agent

Alembic Agent is the runtime package for Agent orchestration, AI providers, tool
contracts, terminal tool envelopes, memory/context handoff, prompts, profiles,
and host-facing execution loops.

The workspace development manifest intentionally consumes Core through the
adjacent source checkout:

```json
"@alembic/core": "file:../AlembicCore"
```

Publish previews are staged separately with `npm run release:pack-preview`. The
staged manifest replaces the local Core dependency with the registry
`@alembic/core` version and records the Core source commit in
`.alembic-source.json`.
