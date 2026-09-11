"""Explicit wire boundary expectations shared by Python and both JS validators."""
import json

TOKEN = '0x'+'a1'*20
OTHER = '0x'+'b2'*20
POOL = '0x'+'c3'*32
MAX_SAFE = 2**53-1


def request_boundaries():
    cases = []
    def add(route, label, body, valid=True, *, parsed_valid=None):
        cases.append({'route':route, 'name':label, 'json':json.dumps(body, ensure_ascii=False, separators=(',', ':')),
                      'valid':valid, 'parsedValid':valid if parsed_valid is None else parsed_valid})
    bases = {'token':{'token':TOKEN}, 'pools':{'token':TOKEN}, 'pool-market':{'poolId':POOL},
             'wallet-assets':{'wallet':TOKEN}, 'nft-positions':{'tokenIds':['0']},
             'catalogue':{'token':TOKEN}, 'pool-activity':{'poolId':POOL},
             'pool-positions':{'poolId':POOL}, 'pool-metrics':{'poolId':POOL}}
    for route, base in bases.items():
        add(route,'minimum',base)
        for name, body in [('empty',{}), ('array',[]), ('null',None), ('scalar',TOKEN),
                           ('unknown-field',{**base,'rpcUrl':'https://untrusted.invalid'}),
                           ('prototype-key',{**base,'__proto__':{}})]:
            add(route,name,body,False)
        # Every address/hash input checks exact length, casing, type and terminal characters.
        key = 'wallet' if route=='wallet-assets' else ('token' if route in ('token','pools','catalogue') else 'poolId')
        if route!='nft-positions':
            original=base[key]
            for name, value, valid in [('upper-digits','0x'+original[2:].upper(),True),
                    ('zero','0x'+'0'*(len(original)-2),True), ('short',original[:-1],False),
                    ('long',original+'0',False), ('newline',original+'\n',False),
                    ('crlf',original+'\r\n',False), ('upper-prefix','0X'+original[2:],False),
                    ('invalid-hex',original[:-1]+'g',False), ('null',None,False),
                    ('number',0,False), ('boolean',True,False)]:
                add(route,key+'-'+name,{**base,key:value},valid)

    def field(route,key,values):
        for name,value,valid in values: add(route,key+'-'+name,{**bases[route],key:value},valid)
    for route in ('pools','catalogue'):
        field(route,'pairedToken',[('null',None,True),('different',OTHER,True),('same',TOKEN,False),
            ('same-uppercase','0x'+TOKEN[2:].upper(),False),('newline',OTHER+'\n',False)])
    for route,key,low,high in [('pools','maxPools',1,20),('catalogue','limit',1,100),
                             ('catalogue','revision',0,MAX_SAFE),('nft-positions','blockNumber',0,MAX_SAFE)]:
        field(route,key,[('min',low,True),('max',high,True),('below',low-1,False),
            ('above',high+1,False),('boolean',True,False),('string',str(low),False),
            ('fraction',1.5,False),('null',None,key in ('revision','blockNumber'))])
        add(route,key+'-float-lexeme',{**bases[route],key:float(low)},False,parsed_valid=True)
        body=json.dumps({**bases[route],key:low},separators=(',',':')).replace('"'+key+'":'+str(low), '"'+key+'":'+str(low)+'e0')
        cases.append({'route':route,'name':key+'-exponent-lexeme','json':body,'valid':False,'parsedValid':True})
    field('pools','poolIds',[('empty',[],True),('ten',[POOL]*10,True),('eleven',[POOL]*11,False),
        ('null',None,False),('bad-item',[POOL+'\n'],False)])
    add('pools','poolIds-fit-maxPools',{'token':TOKEN,'poolIds':[POOL]*10,'maxPools':10})
    add('pools','poolIds-exceed-maxPools',{'token':TOKEN,'poolIds':[POOL]*10,'maxPools':9},False)
    field('catalogue','afterPoolId',[('null',None,True),('without-revision',POOL,False),('bad',POOL+'\n',False)])
    add('catalogue','page-zero-revision',{'token':TOKEN,'afterPoolId':POOL,'revision':0})
    add('catalogue','page-null-revision',{'token':TOKEN,'afterPoolId':POOL,'revision':None},False)
    field('wallet-assets','tokens',[('empty',[],True),('ten',[OTHER]*10,True),('eleven',[OTHER]*11,False),
        ('null',None,False),('bad-item',[OTHER+'\n'],False)])
    field('wallet-assets','cursor',[('null',None,True),('one','x',True),('max','x'*4096,True),
        ('unicode-max','🁣'*4096,True),('above','x'*4097,False),('unicode-above','🁣'*4097,False),
        ('empty','',False),('number',0,False),('boolean',False,False)])
    for route,key in [('wallet-assets','autoDiscover'),('pool-market','includePriceHistory')]:
        field(route,key,[('true',True,True),('false',False,True),('number',1,False),
                        ('string','true',False),('null',None,False)])
    field('pool-market','priceToken',[('base','base',True),('quote','quote',True),('case','BASE',False),
                                     ('other','token0',False),('null',None,False)])
    field('nft-positions','tokenIds',[('max-uint256',[str(2**256-1)],True),('overflow',[str(2**256)],False),
        ('above-78-digits',['1'*79],False),('ten',[str(i) for i in range(10)],True),
        ('eleven',[str(i) for i in range(11)],False),('empty',[],False),('null',None,False),
        ('duplicate',['1','1'],False),('leading-zero',['01'],False),('negative',['-1'],False),
        ('number',[1],False),('newline',['1\n'],False),('crlf',['1\r\n'],False),
        ('exponent',['1e3'],False),('decimal',['1.0'],False),('space',[' 1'],False)])
    return cases
