import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Contact — Yazlık",
  description: "Who to ask, depending on what you are asking about.",
};

/**
 * Deliberately not a form.
 *
 * A contact form here would go to whoever runs this install, which is almost
 * never the person a guest actually needs. Nearly every question about a stay
 * — the dates, the key, whether the dog is fine — is a question for the owner
 * who sent the link, and they are already reachable by the message the link
 * arrived in.
 */
export default function ContactPage() {
  return (
    <>
      <h1>Contact</h1>

      <p>
        It depends what you are asking about, and for most things Yazlık is the
        wrong place to ask.
      </p>

      <h2>About a stay</h2>
      <p>
        Ask the person who sent you the link. They own the house, they decide
        who stays in it, and they can change or cancel any booking. Yazlık has
        no say in it and cannot answer for them.
      </p>

      <h2>About your data</h2>
      <p>
        Also the owner — see <Link href="/legal/privacy">privacy</Link>. They can
        delete a booking outright, which removes everything attached to it.
      </p>

      <h2>About the software</h2>
      <p>
        Yazlık is run by whoever deployed it. If you are reading this on
        somebody&rsquo;s own install, they are the person to tell.
      </p>
    </>
  );
}
