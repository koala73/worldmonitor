import { createPassJobHandler, type PassJobReply, type PassJobRequest } from '@/services/orbital/pass-job';

const post = (reply: PassJobReply) => self.postMessage(reply);
const handle = createPassJobHandler(post);

self.onmessage = (event: MessageEvent<PassJobRequest>) => handle(event.data);

post({ type: 'ready' });
