// A PDF attachment drawn page by page with pdf.js (loaded only when a PDF is opened). The first 50
// pages are drawn; a longer one says to download it.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { t as tr } from "@ferrum/client";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 50;

export default function PdfPages({ data }: { data: Blob }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ pages: number; failed?: string } | null>(null);
  useEffect(() => {
    let gone = false;
    let doc: pdfjs.PDFDocumentProxy | undefined;
    void (async () => {
      try {
        doc = await pdfjs.getDocument({ data: new Uint8Array(await data.arrayBuffer()) }).promise;
        if (gone) return;
        setState({ pages: doc.numPages });
        const width = Math.min(900, (host.current?.clientWidth ?? 800) - 24);
        for (let no = 1; no <= Math.min(doc.numPages, MAX_PAGES) && !gone; no++) {
          const page = await doc.getPage(no);
          const view = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
          const ratio = window.devicePixelRatio || 1;
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(view.width * ratio);
          canvas.height = Math.floor(view.height * ratio);
          canvas.style.width = `${view.width}px`;
          canvas.className = "mx-auto my-3 block bg-white shadow-sm";
          canvas.setAttribute("aria-label", tr("Page {no}", { no }));
          host.current?.append(canvas);
          await page.render({ canvas, viewport: view, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
        }
      } catch (e) {
        if (!gone) setState({ pages: 0, failed: String((e as Error)?.message ?? e) });
      }
    })();
    return () => {
      gone = true;
      void doc?.cleanup();
      host.current?.replaceChildren();
    };
  }, [data]);
  return (
    <div>
      {state?.failed && <p role="alert" className="p-4 text-sm text-destructive">{tr("This PDF could not be shown. Download it to open it.")}</p>}
      <div ref={host} />
      {!!state && state.pages > MAX_PAGES && <p className="p-3 text-center text-sm text-muted-foreground">{tr("The first {n} of {total} pages are shown. Download the file to read the rest.", { n: MAX_PAGES, total: state.pages })}</p>}
    </div>
  );
}
