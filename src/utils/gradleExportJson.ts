import {createScanner, SyntaxKind, ScanError} from 'jsonc-parser';

/** Slice root values without parsing owned subtrees as part of the core graph.
 * Each subtree is subsequently parsed by its own bounded/strict contract. */
export function exportFields(text:string):Map<string,string> {
 if(Buffer.byteLength(text)>64*1024*1024)throw Error('graph_size_limit');
 const scanner=createScanner(text,false),fields=new Map<string,string>();
 const next=()=>{let t:SyntaxKind;do{t=scanner.scan();}while(t===SyntaxKind.Trivia||t===SyntaxKind.LineBreakTrivia);return t;};
 const invalid=():never=>{throw Error('invalid_graph_wrapper');};
 if(next()!==SyntaxKind.OpenBraceToken)invalid();
 let token=next();
 if(token===SyntaxKind.CloseBraceToken){if(next()!==SyntaxKind.EOF)invalid();return fields;}
 while(true){
  if(token!==SyntaxKind.StringLiteral||scanner.getTokenError()!==ScanError.None)invalid();
  const name=scanner.getTokenValue();if(fields.has(name))throw Error('duplicate_json_key');
  if(fields.size>=64)invalid();
  if(next()!==SyntaxKind.ColonToken)invalid();
  token=next();const begin=scanner.getTokenOffset();
  if(token===SyntaxKind.OpenBraceToken||token===SyntaxKind.OpenBracketToken){
   let depth=1;const stack:SyntaxKind[]=[token];
   while(depth){
    token=next();if(token===SyntaxKind.EOF)invalid();
    if(token===SyntaxKind.OpenBraceToken||token===SyntaxKind.OpenBracketToken){depth++;if(depth<=128)stack.push(token);}
    else if(token===SyntaxKind.CloseBraceToken||token===SyntaxKind.CloseBracketToken){
     if(depth<=128){const open=stack.pop();if(open!==(token===SyntaxKind.CloseBraceToken?SyntaxKind.OpenBraceToken:SyntaxKind.OpenBracketToken))invalid();}
     depth--;
    }
   }
  }else if(![SyntaxKind.StringLiteral,SyntaxKind.NumericLiteral,SyntaxKind.TrueKeyword,SyntaxKind.FalseKeyword,SyntaxKind.NullKeyword].includes(token)||scanner.getTokenError()!==ScanError.None)invalid();
  const end=scanner.getTokenOffset()+scanner.getTokenLength();fields.set(name,text.slice(begin,end));
  token=next();if(token===SyntaxKind.CloseBraceToken)break;if(token!==SyntaxKind.CommaToken)invalid();token=next();
 }
 if(next()!==SyntaxKind.EOF)invalid();return fields;
}
