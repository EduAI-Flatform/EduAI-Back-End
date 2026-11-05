import { GdsWalletController } from './gds-wallet.controller';
import { GdsWalletService } from './gds-wallet.service';
import { parseHistoryQuery } from './gds-wallet-history';
describe('wallet history API boundary',()=>{
  it('uses the authenticated owner and validates query parameters before reading',()=>{
    const wallet={transactions:jest.fn().mockReturnValue({items:[],hasMore:false,nextCursor:null})};
    const controller=new GdsWalletController(wallet as never,undefined as never,undefined as never,undefined as never);
    controller.transactions('owner','incoming','20');
    expect(wallet.transactions).toHaveBeenCalledWith('owner',{filter:'incoming',limit:20});
    expect(()=>controller.transactions('owner','all','500')).toThrow();
    expect(()=>controller.transactions('owner','all','20','invalid')).toThrow();
    expect(wallet.transactions).toHaveBeenCalledTimes(1);
  });
  it('keeps the read capability gate and performs no initialization or financial writes',async()=>{
    const db={$queryRaw:jest.fn().mockResolvedValue([])};
    const disabled=new GdsWalletService(db as never,{app:{deploymentClass:'uat',nodeEnv:'test'},gdsWallet:{sandboxEnabled:false}} as never);
    expect(()=>disabled.transactions('owner',parseHistoryQuery('owner'))).toThrow();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    const enabled=new GdsWalletService(db as never,{app:{deploymentClass:'uat',nodeEnv:'test'},gdsWallet:{sandboxEnabled:true}} as never);
    expect(await enabled.transactions('owner',parseHistoryQuery('owner'))).toEqual({items:[],hasMore:false,nextCursor:null});
  });
});
