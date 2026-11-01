import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Extracts all text from a PDF file, page by page, for phone-number scanning. */
export async function extractPdfText(file: File): Promise<string> {
	const buffer = await file.arrayBuffer();
	const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
	const pageTexts: string[] = [];
	for (let i = 1; i <= pdf.numPages; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();
		const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
		pageTexts.push(text);
	}
	return pageTexts.join("\n");
}
