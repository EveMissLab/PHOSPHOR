#![no_std]
#![no_main]

use core::panic::PanicInfo;
use core::ptr::{addr_of, addr_of_mut, write_volatile, read_volatile};

#[panic_handler]
fn panic(_info: &PanicInfo) -> ! {
    loop {}
}

static mut FIB_BUF: [i32; 32] = [0; 32];

#[inline(never)]
fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[no_mangle]
pub extern "C" fn buffer_ptr() -> i32 {
    addr_of!(FIB_BUF) as i32
}

#[no_mangle]
pub extern "C" fn main(n: i32) {
    unsafe {
        let mem = addr_of_mut!(FIB_BUF) as *mut i32;
        write_volatile(mem.offset(0), 0);
        write_volatile(mem.offset(1), 1);
        let mut i: i32 = 2;
        let mut a: i32 = 0;
        let mut b: i32 = 1;
        while i <= n {
            let tmp = add(a, b);
            write_volatile(mem.offset(i as isize), tmp);
            a = b;
            b = tmp;
            i += 1;
        }
    }
}
