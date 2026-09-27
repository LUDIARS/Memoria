/** Keep both direct and Access-protected editor links on the Memoria origin. */
export function localTabulaBrowserUrl(pageId?:string):string {
  const hash=new URLSearchParams({workspace:'local'});
  if(pageId)hash.set('page',pageId);
  return `/tabula/#${hash}`;
}
