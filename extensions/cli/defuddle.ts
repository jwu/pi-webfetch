export async function convertHtmlWithDefuddle(html: string, url: string): Promise<string> {
  const { Defuddle } = await import('defuddle/node');
  const result = await Defuddle(html, url, {
    markdown: true,
    useAsync: false,
  });
  const markdown = result.contentMarkdown ?? result.content;

  if (!markdown || !markdown.trim()) {
    throw new Error('Defuddle returned empty markdown content.');
  }

  return markdown;
}
