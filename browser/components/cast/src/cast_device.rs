use nserror::{nsresult, NS_ERROR_NOT_AVAILABLE, NS_OK};
use nsstring::{nsACString, nsCString};
use std::cell::RefCell;
use xpcom::interfaces::nsICastDeviceCallback;
use xpcom::{xpcom_method, RefPtr};

#[xpcom::xpcom(implement(nsICastDevice), atomic)]
pub struct CastDevice {
    state: RefCell<nsCString>,
    callback: RefCell<Option<RefPtr<nsICastDeviceCallback>>>,
}

impl CastDevice {
    pub fn new() -> RefPtr<Self> {
        println!("CastDevice::new() creating new instance");
        CastDevice::allocate(InitCastDevice {
            state: RefCell::new(nsCString::from("disconnected")),
            callback: RefCell::new(None),
        })
    }

    xpcom_method!(connect => Connect(address: *const nsACString, port: i32));
    fn connect(&self, address: &nsACString, port: i32) -> Result<(), nsresult> {
        println!("CastDevice::connect called: {}:{}", address, port);
        Ok(())
    }

    xpcom_method!(disconnect => Disconnect());
    fn disconnect(&self) -> Result<(), nsresult> {
        println!("CastDevice::disconnect called");
        Ok(())
    }

    xpcom_method!(send_message => SendMessage(namespace: *const nsACString, payload: *const nsACString));
    fn send_message(&self, namespace: &nsACString, payload: &nsACString) -> Result<(), nsresult> {
        println!(
            "CastDevice::sendMessage called: {} - {}",
            namespace, payload
        );
        Ok(())
    }

    xpcom_method!(get_callback => GetCallback() -> *const nsICastDeviceCallback);
    fn get_callback(&self) -> Result<RefPtr<nsICastDeviceCallback>, nsresult> {
        match &*self.callback.borrow() {
            Some(cb) => Ok(cb.clone()),
            None => Err(NS_ERROR_NOT_AVAILABLE),
        }
    }

    xpcom_method!(set_callback => SetCallback(callback: *const nsICastDeviceCallback));
    fn set_callback(&self, callback: Option<&nsICastDeviceCallback>) -> Result<(), nsresult> {
        println!("CastDevice::setCallback called");
        *self.callback.borrow_mut() = callback.map(|cb| RefPtr::new(cb));
        Ok(())
    }

    xpcom_method!(get_state => GetState() -> nsACString);
    fn get_state(&self) -> Result<nsCString, nsresult> {
        Ok(self.state.borrow().clone())
    }
}
