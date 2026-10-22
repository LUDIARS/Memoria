// Contract evidence only; no service or test runner is started.
import { renderInlineEvidence, renderBlockEvidence } from './markdown-boundary.ts';

const payloads = [
  '<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
  '<div><img src=x onerror=alert(1)></div>',
  '<span><a href="javascript:alert(1)">click</a></span>',
  '<svg onload=alert(1)></svg>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<b>literal HTML</b>', '<img', '&lt;img src=x onerror=alert(1)&gt;',
  '**bold** *italic* `<img>` [safe](https://example.com)',
  '[bad](javascript:attack) [bad](data:text/html,attack)',
];
for (const input of payloads) {
  renderInlineEvidence(input);
  renderInlineEvidence(`**${input}**`);
  renderBlockEvidence(input);
  renderBlockEvidence(`# ${input}\n\n> ${input}\n\n- ${input}\n\n1. ${input}\n\n| safe | ${input} |\n| --- | --- |\n| ${input} | safe |\n\n\`\`\`html\n${input}\n\`\`\``);
}
