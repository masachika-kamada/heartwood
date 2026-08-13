/**
 * The worked examples offered under the GitHub field.
 *
 * They exist because one field accepting two different kinds of thing is not
 * something a sentence reliably conveys — clicking one does. That makes a
 * broken example worse than none at all, so they live here as data rather than
 * as markup, and a test asserts each one still parses as the kind it claims to
 * demonstrate.
 */

export interface InputExample {
  /** Exactly what is typed into the field. */
  readonly value: string;
  /** Which of the two readings this example is here to teach. */
  readonly demonstrates: "repo" | "user";
}

export const INPUT_EXAMPLES: readonly InputExample[] = [
  { value: "facebook/react", demonstrates: "repo" },
  { value: "torvalds", demonstrates: "user" },
];
