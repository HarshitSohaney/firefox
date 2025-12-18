use nserror::{nsresult, NS_OK};
use xpcom::{xpcom_method, RefPtr};

#[xpcom::xpcom(implement(nsIInterfaceRequestor), atomic)]
pub struct CertOverrideCallbacks {}

impl CertOverrideCallbacks {
    pub fn new() -> RefPtr<Self> {
        CertOverrideCallbacks::allocate(InitCertOverrideCallbacks {})
    }

    xpcom_method!(get_interface => GetInterface(uuid: *const xpcom::nsIID, result: *mut *mut libc::c_void));
    fn get_interface(
        &self,
        _uuid: &xpcom::nsIID,
        _result: *mut *mut libc::c_void,
    ) -> Result<(), nsresult> {
        Ok(())
    }
}
