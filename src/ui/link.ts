/**
 * What the address after `#` asks for.
 *
 *   #name               draw this repository or person
 *   #name?ring=12       …and point at ring 12
 *   #name@600?213,188   …and point at whatever ring lies under that spot of
 *                       the README picture, shown 600 pixels wide
 *
 * The last form is not typed by anyone. A README image marked `ismap` makes
 * the browser append "?x,y" — where on the image the click landed — to the
 * link it sits in, after the fragment and all. That is the one way a click
 * on a picture in a README can say *where* it was.
 */

export interface TreeLink {
  readonly name: string;
  readonly ring: number | null;
  /** A click on the README picture, in the pixels it was displayed at. */
  readonly point: { readonly x: number; readonly y: number; readonly shownWidth: number } | null;
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

  const sized = /^(.*)@(\d{2,4})$/.exec(target);
  const name = (sized ? sized[1]! : target).trim();
  if (name === "") {
    return null;
  }

  const ring = /^ring=(\d{1,4})$/.exec(query);
  const spot = /^(\d{1,4}),(\d{1,4})$/.exec(query);

  return {
    name,
    ring: ring ? Number(ring[1]) : null,
    point:
      sized && spot
        ? { x: Number(spot[1]), y: Number(spot[2]), shownWidth: Number(sized[2]) }
        : null,
  };
}
