# `plexus mcp`

A stdio MCP server for an agent host, in the scope given when it starts. A
host passes its project directory, whose name is the scope:

```json
{ "mcpServers": { "plexus": { "command": "plexus", "args": ["mcp", "--project", "/path/to/MyProject"] } } }
```

An empty `--project`, or one holding a `${...}` variable the host did not
expand, is refused and the server does not start, rather than give every
project the same scope.

It offers `image_templates`, `image_create`, `image_start`, `image_stop`,
`image_delete` and `image_list`, followed by the tools of every image in scope
that runs with an endpoint. Each of those takes an `image` argument naming the
image to call. A call naming none goes to the only image running; while
several run, to the only one that lists the tool when every one could be
asked, and it is refused naming them otherwise. After a create that starts its
image, a start, a stop or a delete, the server tells the host its tool list
changed; an image started or stopped elsewhere is seen at the next listing.
Its instructions, which the host reads when a session starts, say how to work
with images.

Its own tools name the image with an `image` argument too. `image_create`
starts the image it made unless given `start: false`, and creates from the
current stable Pharo unless given a template, which it finds as
[Images](images.md#templates) says; its answer names the template when the
call named another or none. `image_delete` refuses a running image unless
given `stop: true`, which stops it without saving first. `image_stop` and
`image_delete` take one image or several: several are handled in turn, and
the answer says what each did and why any was not done.

Its own tools answer in plain text, for a model: what happened first, then
what it found. `image_list` gives each image one line under its state, running
images first, with what tells it from the usual, and for a stopped image when
it was last used and how large it is; named, an image is given whole, with its
path. A warning that holds for several images is said once, naming them. A refusal, a call whose arguments break the tool's schema
among them, is an error result that says what happened and what to do. A
forwarded call waits as long as the call's own time limit allows, and at least
a minute; whatever the image answers passes through as it is, and a call that
gets no answer says what became of the image.
