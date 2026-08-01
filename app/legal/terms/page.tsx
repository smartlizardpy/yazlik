import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms — Yazlık",
  description: "What Yazlık is, and what it is not.",
};

export default function TermsPage() {
  return (
    <>
      <h1>Terms</h1>

      <p>
        Yazlık is a way for someone to share their own summer house with people
        they know. It is free, and it is offered as it is, with no promise that
        it will be available or that it will not lose something.
      </p>

      <h2>It does not book anything</h2>
      <p>
        Yazlık passes a request from a guest to an owner and records the
        answer. It is not an agent, a broker or a rental platform, it holds no
        money, and it is not a party to whatever the two of you agree. The
        arrangement is between the person who owns the house and the person
        staying in it, exactly as it was before.
      </p>

      <h2>The owner decides</h2>
      <p>
        A request is a request. The owner can say yes, say not that week, or
        say nothing at all, and Yazlık never confirms a stay on their behalf.
      </p>

      <h2>What the owner is responsible for</h2>
      <ul>
        <li>That the house is theirs to lend.</li>
        <li>That what they write about it is true.</li>
        <li>That they have the right to share the photographs they upload.</li>
        <li>Who they let in, and what happens while those people are there.</li>
      </ul>

      <h2>The link is the key</h2>
      <p>
        Anyone holding a house link can ask for dates, and anyone holding a
        booking link can see that booking. They are unguessable, but they are
        not passwords — treat them the way you would treat a key under a pot,
        and send them only to people you mean to let in.
      </p>

      <h2>Things not to do</h2>
      <p>
        Do not use Yazlık to run a business, to take money, to upload anything
        that is not yours, or to do anything illegal where you or the house
        are. An install can be shut down without notice, and that is the whole
        enforcement mechanism.
      </p>

      <h2>Changes</h2>
      <p>
        These terms can change. There is no mailing list to tell you so; the
        page is the notice.
      </p>
    </>
  );
}
