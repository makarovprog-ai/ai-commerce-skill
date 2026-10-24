// Isolated reader: a blocked inherited descriptor cannot pin the CLI's fs worker.
// The parent bounds lifetime/output and never exposes this private stdout channel.
import {readSync,writeSync} from 'node:fs';
const bytes=Buffer.alloc(4097);let length=0;
try {
  while(length<bytes.length) {
    const count=readSync(3,bytes,length,bytes.length-length,null);
    if(!count)break;length+=count;
    if(bytes.subarray(0,length).includes(10))break;
  }
  if(length===bytes.length)process.exitCode=1;
  else writeSync(1,bytes.subarray(0,length));
}catch{process.exitCode=1;}finally{bytes.fill(0);}
