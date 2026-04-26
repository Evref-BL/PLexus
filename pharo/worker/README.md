# Pharo Worker

This directory will hold the in-image worker bootstrap.

The first version should be a Smalltalk script launched with the target image. It should:

1. Load or verify the Pharo MCP worker package.
2. Bind to `127.0.0.1` on the port selected by the orchestration layer.
3. Require a per-worker token.
4. Report health and loaded project status.

Do not put PLexus or MCP-PL here. This code runs inside a mutable image and must be replaceable.
