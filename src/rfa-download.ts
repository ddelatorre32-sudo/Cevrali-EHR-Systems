import templateUrl from "../server/templates/dwc-rfa-2014.pdf?url&inline";
import fontUrl from "../server/templates/rfa-font.ttf?url&inline";
import { generateRfaPdf } from "../server/rfa-pdf";
import type { RfaPacket } from "../server/rfa-engine";
import { assertCurrentSession, sessionContextVersion } from "./api";
function bytes(url: string) {
  return Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) =>
    c.charCodeAt(0),
  );
}
export async function downloadRfa(
  packet: RfaPacket,
  version = sessionContextVersion(),
) {
  assertCurrentSession(version);
  const data = await generateRfaPdf(packet, bytes(templateUrl), bytes(fontUrl));
  assertCurrentSession(version);
  const url = URL.createObjectURL(
    new Blob([data as BlobPart], { type: "application/pdf" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${packet.id}-${packet.status === "Draft" ? "draft" : "provider-signed"}-rfa.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return data;
}
