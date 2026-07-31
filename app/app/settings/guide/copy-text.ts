/**
 * Putting a block of text on the clipboard, on a phone, off a secure origin.
 *
 * The same two tiers `app/app/share/share-links.tsx` uses, and for the same
 * reason: `navigator.clipboard` only exists in a secure context, and an owner
 * opening this on their phone at `http://192.168.1.7:3100` — sitting next to
 * the laptop running it — is not in one. It is written out again here rather
 * than exported from that file because that file is a component about links and
 * this is a function about text; a shared helper would mean one of the two
 * importing the other's component module for a twelve-line utility.
 *
 * There is no third tier here. Over there the fallback is to select the link on
 * screen, because the link is one line and a long-press can take it. This is a
 * two-thousand-character prompt, so the caller's answer to `false` is to put
 * the whole thing in a readonly textarea and select it — which is markup, not
 * a function.
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, or a browser that exposes the API off a secure origin
    // and then refuses it. Either way the fallback below is the answer.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // Off-screen but still focusable. `display: none` cannot be selected, and
    // scrolling the page to a visible one is worse than either.
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
