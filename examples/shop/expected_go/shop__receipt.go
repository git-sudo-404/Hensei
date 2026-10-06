package main

import "strconv"

func H_73686f702e726563656970742e72656365697074(name string, count int64, price int64, vip bool) string {
    return H_73686f702e6c6162656c732e6c6162656c(name) + ": " + strconv.FormatInt(H_73686f702e746f74616c732e746f74616c(count, price, vip), 10) + " cents"
}
