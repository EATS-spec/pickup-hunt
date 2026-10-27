import {readFile,writeFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const markup=source.match(/<body>\s*([\s\S]*?)\s*<\/body>/)?.[1];
if(!markup)throw new Error('Public page body was not found.');
const output=`"use client";\n\nimport { useEffect } from "react";\n\nconst markup = ${JSON.stringify(markup)};\n\nexport default function Home() {\n  useEffect(() => {\n    if (document.querySelector('script[data-pickup-hunt-app]')) return;\n    const script = document.createElement("script");\n    script.type = "module";\n    script.src = "/app.js";\n    script.dataset.pickupHuntApp = "true";\n    document.body.appendChild(script);\n  }, []);\n  return <div dangerouslySetInnerHTML={{ __html: markup }} />;\n}\n`;
await writeFile(new URL('../app/page.tsx',import.meta.url),output);
console.log('Synced public markup to the Vinext homepage.');
