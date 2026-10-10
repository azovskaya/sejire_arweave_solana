-- Exact decimal strings. No whole-amount tonumber(), float or u64 wraparound.
local M = {}
function M.check(value)
  assert(type(value) == 'string' and (value == '0' or value:match('^[1-9]%d*$')), 'invalid_lamports')
  return value
end
function M.compare(a,b)
  M.check(a);M.check(b)
  if #a ~= #b then return #a < #b and -1 or 1 end
  if a == b then return 0 end
  return a < b and -1 or 1
end
function M.add(a,b)
  M.check(a);M.check(b)
  local i,j,carry,out=#a,#b,0,''
  while i>0 or j>0 or carry>0 do
    local x=i>0 and a:byte(i)-48 or 0
    local y=j>0 and b:byte(j)-48 or 0
    local n=x+y+carry
    out=string.char(48+n%10)..out
    carry=math.floor(n/10);i=i-1;j=j-1
  end
  return out
end
function M.u64(value)
  M.check(value);assert(M.compare(value,'18446744073709551615')<=0,'u64_overflow');return value
end
return M
