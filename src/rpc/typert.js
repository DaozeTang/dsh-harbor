/**
 * Host typert artifact: discovered automatically by @deepseek-ai/dsh-typert-loader
 * through the package's "./typert" export and registered into ctx.typert, which
 * the typert gateway consults for strict dispatch codecs.
 */
import { DESCRIPTORS } from "./descriptors.js";
import { sshErrorSchema } from "./schemas.js";
import { DECLARATIONS } from "./declarations/index.js";
import { MEMBERS } from "./typert.generated.js";

export const TYPERT = {
  package: "dsh-harbor",
  face: "host",
  schemas: [
    // 0.1.6-alpha.2 loader requires create(); alpha.1 registry reads .schema — ship both.
    { name: "sshError", schema: sshErrorSchema, create: () => sshErrorSchema }
  ],
  invocations: DESCRIPTORS,
  model: {
    events: [],
    objects: [],
    services: [
      {
        description: "SSH ops sessions for the Web UI: connect to remote hosts, open PTY shells, stream input and output, resize, and disconnect. Backed by ssh2 in the host process.",
        summary: "SSH remote sessions backed by ssh2.",
        tags: [],
        jsDoc: "/**\n * SSH remote terminal sessions for the Web UI.\n */",
        key: "harbor",
        exportName: "HarborService",
        members: MEMBERS,
        types: DECLARATIONS
      }
    ]
  }
};

export default TYPERT;
