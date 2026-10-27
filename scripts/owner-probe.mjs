// Owner-only diagnostics. Credential arrives on hidden stdin, never arguments/files.
if(process.stdin.isTTY)process.stdin.setRawMode(true);
process.stdout.write('Ready for hidden Site request JSON\n');
let input='';
process.stdin.on('data',async chunk=>{
 input+=chunk.toString();if(!input.includes('\n'))return;process.stdin.pause();
 try{
  const {origin,credential,path,body}=JSON.parse(input);
  const url=new URL(path,origin);
  if(url.origin!==new URL(origin).origin||url.protocol!=='https:')throw new Error('Request must remain on the supplied HTTPS Site.');
  const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'OAI-Sites-Authorization':`Bearer ${credential}`,Authorization:`Bearer ${credential}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text.slice(0,500);}
  process.stdout.write(JSON.stringify({status:response.status,data})+'\n');process.exit(response.ok?0:1);
 }catch(error){process.stdout.write(JSON.stringify({error:error.message})+'\n');process.exit(1);}
});
