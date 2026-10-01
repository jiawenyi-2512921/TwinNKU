export type SpeechCaption = { text: string; start: number; end: number };

// Keep offsets in the original utterance: speech boundary events index that
// string, not the shortened caption. Code points avoid splitting surrogate pairs.
export function splitSpeechCaptions(text: string): SpeechCaption[] {
  const characters = Array.from(text);
  const offsets = [0];
  for (const character of characters)
    offsets.push(offsets[offsets.length - 1] + character.length);
  const captions: SpeechCaption[] = [];
  let start = 0;
  while (start < characters.length) {
    while (start < characters.length && /\s/u.test(characters[start])) start++;
    if (start === characters.length) break;
    const limit = Math.min(start + 52, characters.length);
    let end = limit;
    let softBreak = 0;
    for (let index = start; index < limit; index++) {
      const character = characters[index];
      if (/[，、,:：\s]/u.test(character)) softBreak = index + 1;
      if (
        /[。！？!?；;\n]/u.test(character) ||
        (character === "." &&
          (!characters[index + 1] ||
            /[\s”’"')）]/u.test(characters[index + 1])))
      ) {
        end = index + 1;
        // Closing quotes and punctuation belong with the sentence they close.
        while (
          end < characters.length &&
          /[。！？!?；;”’"')）]/u.test(characters[end])
        )
          end++;
        break;
      }
      if (
        index === limit - 1 &&
        limit < characters.length &&
        softBreak > start + 20
      )
        end = softBreak;
    }
    let visibleEnd = end;
    while (visibleEnd > start && /\s/u.test(characters[visibleEnd - 1]))
      visibleEnd--;
    if (visibleEnd > start)
      captions.push({
        text: text.slice(offsets[start], offsets[visibleEnd]),
        start: offsets[start],
        end: offsets[visibleEnd],
      });
    start = end;
  }
  return captions;
}

export function speechCaptionAt(
  captions: readonly SpeechCaption[],
  charIndex: number,
): SpeechCaption | undefined {
  if (!Number.isInteger(charIndex) || charIndex < 0 || !captions.length)
    return undefined;
  const last = captions[captions.length - 1];
  if (charIndex > last.end) return undefined;
  // A boundary on whitespace keeps the preceding sentence until speech reaches
  // the next one; engines that emit no boundaries simply keep the first caption.
  for (let index = captions.length - 1; index >= 0; index--)
    if (captions[index].start <= charIndex) return captions[index];
  return captions[0];
}
