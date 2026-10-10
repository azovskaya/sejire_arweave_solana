/** Deterministic UTF-8 signing domain; integer numbers only, money is decimal strings. */
export const DOMAIN='sejire/protocol-journal/v1';
export const canonical=(value:unknown):string=>{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isSafeInteger(value))throw Error('non_integer_number');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)throw Error('invalid_canonical_value');
 return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
};
