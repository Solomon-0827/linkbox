'use strict';

const isNativeIP=typeof module==='object'?require('node:net').isIP:null;

function canonicalIP(value){
 if(typeof value!=='string'||(isNativeIP&&!isNativeIP(value)))return '';
 const [address,zone,extra]=value.split('%');
 if(!address.includes(':')){
  return zone===undefined&&/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address)&&
   address.split('.').every(octet=>Number(octet)<=255)?address:'';
 }
 if(extra!==undefined||zone===''||/[^0-9a-f:.]/i.test(address))return '';
 try{
  const canonical=new URL('http://['+address+']').hostname.slice(1,-1);
  return zone===undefined?canonical:canonical+'%'+zone;
 }catch{return '';}
}

function sameIP(left,right){
 const address=canonicalIP(left);
 return Boolean(address)&&address===canonicalIP(right);
}

if(typeof module==='object')module.exports={sameIP};
