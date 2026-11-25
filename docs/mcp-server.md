# `plexus mcp`

A stdio MCP server for an agent host, in the scope given when it starts. A
host passes its project directory, whose name is the scope:

```json
{ "mcpServers": { "plexus": { "command": "plexus", "args": ["mcp", "--project", "/path/to/MyProject"] } } }
```

It offers `image_templates`, `image_create`, `image_start`, `image_stop`,
`image_delete` and `image_list`, followed by the tools of every image in scope
that runs with an endpoint. Each of those takes an `image` argument naming the
image to call; it may be left out while one image runs. A call naming no image
while several run goes to the only one that lists the tool, and is answered
that none has it when none does. After a start, a stop
or a delete, the server tells the host its tool list changed. Its instructions tell the host to search these tools for Pharo work,
that an image takes one writer, to stop an image once its work pauses, and to
propose deleting the images unused for a while. `image_stop` and
`image_delete` take one name or several: several are handled in turn, and the
answer says what each did and why any was not done.

Its own tools answer in plain text, for a model: what happened first, then
what it found. `image_list` gives each image one line under its state, running
images first, with only what differs from the usual: the template when it is
not the plain one of its Pharo version, the MCP when it is not the one images
are created with, and for a stopped image the day it was last used (the later
of its last start and its last save) and the size of its image file. A warning that holds for several images is said once, naming
them. A refusal, a call whose arguments break the tool's schema
among them, is an error result that says what happened and what to do. A
forwarded call waits as long as the call's own time limit allows, and at least
a minute; whatever the image answers passes through as it is, and a call that
gets no answer says what became of the image.
