# Images

## Images are directories, running images are processes

- **An image is a directory** of PLexus's Pharo Launcher profile:
  `$PLEXUS_HOME/profiles/images/<name>/<name>.image`, with `PLEXUS_HOME`
  defaulting to `~/.plexus`. It exists when that file does. Nothing declares
  it first and nothing remembers it after.
- **A running image is a process**: a VM whose command line names that image
  file, compared on the real path. Every call asks the host's process list
  once, the way `ps` does, so an answer is as old as the call that gave it.
  Nothing tells PLexus that a VM stopped, so nothing records that one started.
  The one exception is a call `plexus mcp` forwards: it goes without asking
  while the VM an earlier look of the same server saw answering for the image
  still runs, and the endpoint files name no other image that answers.
- **A scope is a name prefix.** With scope `Proj`, image `dev` is the directory
  `Proj-dev`, and only `Proj-` directories are listed, without the prefix.
  A scope holds no dash, so the first dash of a directory name ends its scope:
  `shop` never lists `shop_api-dev`, which is `shop_api`'s. PLexus stores no
  scope: the caller passes one, and without one an image is named by its
  directory, so `shop-dev` is image `dev` of `shop`, and every image is
  listed.

An image keeps what PLexus knows about it in `<image>/plexus/`, which goes
with it:

| File | Written | Read |
| --- | --- | --- |
| `created.properties` | by create: template, category, how MCP got in, PLexus version, whether it records its calls | by list |
| `on-start` | by create with `--every-start`: the script to file in | by every start, before MCP starts |
| `endpoint.properties` | by the running VM: the port it bound, its pid, whether it records its calls | by list and forwarding, while that pid runs the image |
| `start.st`, `start-status.properties`, `launch.lock` | during a start | by that start |
| `building` | by a create with a script, naming its process, until the image is ready | by list, start and delete |

A create with a script builds the image under a name of its own and renames it
in with `building`, which start refuses. While that create runs, delete
refuses the image too; once its process is gone, delete is how the unfinished
image goes. What a PLexus that was killed left elsewhere, a base it was
building or a directory it was copying or removing, is named after its
process, and the next create removes it.

## MCP in an image

Without a script, an image is a copy of a **base**: its template with the MCP
release PLexus pins loaded and saved. The first create from a template builds
the base, which takes minutes; later creates copy it, cloning blocks where the
filesystem can. A base is a directory of `$PLEXUS_HOME/bases/shared` named
after its template, category and pin, and whether it holds MCP's `Telemetry`
group. It is built under a temporary name and renamed when complete, so its
existence is its record. Beside it, `<base>.used` holds when a create last
copied it, written before the copy.

Releases with other pins share the bases, as when an agent host runs an older
PLexus beside a newer one, so a base is never removed for its pin. A create
removes the bases no create has used for 30 days and, while the bases hold
more than 5 GiB, the least recently used first, but never one used within the
last day. PLexus 0.16 to 0.20 keep their bases directly in `$PLEXUS_HOME/bases`
and remove those of other pins there, which never reaches `shared`. The
bases there are neither copied nor removed.

A base forgets the Iceberg repositories its load cloned into the image's directory and
deletes their clones, so that a project loading MCP under another repository
spec, a fork or a branch, clones it anew.

Before anything loads, PLexus has Iceberg clone `github://` repositories over
HTTPS (`Iceberg remoteTypeSelector: #httpsUrl`), which a public repository
needs no credentials for; the image keeps that setting. An image whose
projects clone private repositories over SSH sets `#scpUrl` back.

With `--script`, the image is built from the template and the script is filed
in once instead, which is how an image gets MCP from a checkout or an older
Pharo gets a version that loads on it. With `--every-start` as well, every
start files the script in again before the server starts, so an image follows
the checkout it loads from.
