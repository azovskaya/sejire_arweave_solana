/** Kernel-held single-writer guard shared by startup, import, restore and review. */
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export async function canonicalDatabasePath(input){
  const requested=resolve(input),parent=await realpath(dirname(requested));
  const named=join(parent,basename(requested));
  let info;
  try{info=await lstat(named);}catch(error){if(error.code==='ENOENT')return named;throw error;}
  const path=info.isSymbolicLink()?await realpath(named):named;
  info=await lstat(path);
  // A hard-linked ledger could have two different sibling guard paths.
  if(!info.isFile()||info.nlink!==1)throw Error('invalid_backend_database_path');
  return path;
}

export async function acquireWriter(path){
  const directory=path+'.writer.lock';
  // A permanent directory also blocks the previous adapter's open('wx'). A
  // legacy regular sentinel is never removed or guessed to be stale here.
  try{await mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const info=await lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw Error('backend_writer_already_active');
  const guardPath=join(directory,'guard.sqlite');
  try{
    const existing=await lstat(guardPath);
    if(!existing.isFile()||existing.isSymbolicLink()||existing.nlink!==1)throw Error('invalid_backend_writer_guard');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  let guard;
  try{
    guard=new DatabaseSync(guardPath);
    guard.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE');
    return guard;
  }catch(error){
    guard?.close();
    if(error.errcode===5||error.errcode===6)throw Error('backend_writer_already_active');
    throw error;
  }
}

export async function assertRestoreReviewed(path) {
  try { await lstat(path + '.restore-review.json'); throw Error('linux_restore_review_required'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
