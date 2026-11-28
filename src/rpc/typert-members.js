/**
 * Derive the published signature of every service member from its descriptor
 * and its implementation.
 *
 * The manifest used to repeat all 66 signatures by hand next to the descriptor
 * that already names the request and result types, so adding a method meant
 * editing two places and a typo in the copy stayed invisible. The only thing a
 * descriptor cannot express is whether the implementation is async, and that
 * is read from the prototype instead of being guessed from the method name.
 */

const typeName = (symbol) => symbol.slice(symbol.indexOf("#") + 1);

const kindOf = (implementation) => implementation?.constructor?.name ?? "Function";

/**
 * @param {Array<object>} descriptors - DESCRIPTORS from descriptors.js.
 * @param {object} prototype - HarborService.prototype (mixin chain included).
 * @returns {Array<{kind: "method", name: string, signature: string}>}
 */
export function deriveMembers(descriptors, prototype) {
  return descriptors.map((descriptor) => {
    const request = typeName(descriptor.parameters[0].codec.typeSymbol);
    const result = typeName(descriptor.result.typeSymbol);
    const implementationKind = kindOf(prototype?.[descriptor.method]);
    if (descriptor.mode === "stream" || implementationKind === "AsyncGeneratorFunction") {
      return {
        kind: "method",
        name: descriptor.method,
        signature: "async *" + descriptor.method + "(request: " + request + ", signal?: AbortSignal): AsyncGenerator<" + result + ">",
      };
    }
    const prefix = implementationKind === "AsyncFunction" ? "async " : "";
    return {
      kind: "method",
      name: descriptor.method,
      signature: prefix + descriptor.method + "(request: " + request + "): Promise<" + result + ">",
    };
  });
}
