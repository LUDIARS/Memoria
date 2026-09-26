import type {ChatExtractedMessage,ChatExtractionSource,NotionExtractedBlock} from '../api/types/extraction.js';
import type {ImportElement,TabulaImport} from './client.js';

export function chatDocument(input:{source:ChatExtractionSource;url:string;title:string;conversationId?:string;memo?:string;messages:ChatExtractedMessage[]}):TabulaImport {
  const elements:ImportElement[]=[{block_type:'quote',text:`Source: ${input.source}\nURL: ${input.url}${input.memo?'\n'+input.memo:''}`}];
  for(const message of input.messages) {
    if(typeof message.text!=='string'||!message.text.trim())continue;
    elements.push({block_type:'heading_3',text:message.role},{block_type:'text',text:message.text});
  }
  return {title:input.title||`${input.source} chat`,kind:'chat',tags:[input.source],source_kind:'chat',source_ref:input.conversationId||input.url,elements};
}
export function notionDocument(input:{url:string;title:string;pageId?:string;memo?:string;blocks:NotionExtractedBlock[]}):TabulaImport {
  const elements:ImportElement[]=[];
  if(input.memo)elements.push({block_type:'quote',text:input.memo});
  for(const block of input.blocks) {
    if(block.kind==='bookmark') {elements.push({block_type:'bookmark_embed',text:'',data:{bookmark_url:block.url,title:block.title??block.caption??block.url,summary:block.caption??'',image:block.image}});continue;}
    const data:Record<string,unknown>={};
    if('checked' in block)data.checked=block.checked;if('indent' in block)data.indent=block.indent;if('lang' in block)data.lang=block.lang;
    elements.push({block_type:block.kind,text:'text' in block?block.text:'',data});
  }
  return {title:input.title,tags:['notion'],source_kind:'notion',source_ref:input.pageId||input.url,elements};
}
