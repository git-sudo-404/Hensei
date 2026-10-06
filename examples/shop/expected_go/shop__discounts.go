package main

func H_73686f702e646973636f756e74732e646973636f756e74(count int64, price int64, vip bool) int64 {
    if !vip { return 0 }
    amount := H_73686f702e626173652e737562746f74616c(count, price)
    quotient := amount / 10
    if amount < 0 && amount % 10 != 0 { quotient-- }
    return quotient
}
