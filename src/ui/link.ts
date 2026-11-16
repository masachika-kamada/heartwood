/**
 * What the address after `#` asks for.
 *
 *   #name               draw this repository or person
 *   #name?ring=12       …and point at ring 12, as a band of the core sample
 *                       in a README does
 */

export interface TreeLink {
  readonly name: string;
  readonly ring: number | null;
}

export function parseTreeLink(hash: string): TreeLink | null {
  let text: string;
  try {
    text = decodeURIComponent(hash.replace(/^#\/?/, "")).trim();
  } catch {
    return null;
  }
  if (text === "") {
    return null;
  }

  const question = text.indexOf("?");
  const target = question === -1 ? text : text.slice(0, question);
  const query = question === -1 ? "" : text.slice(question + 1);

  const name = target.trim();
  if (name === "") {
    return null;
  }

  const ring = /^ring=(\d{1,4})$/.exec(query);

  return { name, ring: ring ? Number(ring[1]) : null };
}
