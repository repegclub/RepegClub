import type { Adapter } from "@goblinhunt/cosmes/client";
import {
  CosmwasmWasmV1MsgInstantiateContract as ProtoMsgInstantiateContract,
  CosmwasmWasmV1MsgStoreCode as ProtoMsgStoreCode,
} from "@goblinhunt/cosmes/protobufs";

type Coin = { denom: string; amount: string };

export class MsgStoreCode implements Adapter {
  constructor(private readonly data: { sender: string; wasmByteCode: Uint8Array }) {}

  public toProto() {
    return new ProtoMsgStoreCode(this.data);
  }

  public toAmino() {
    return {
      type: "wasm/MsgStoreCode",
      value: {
        sender: this.data.sender,
        wasm_byte_code: Buffer.from(this.data.wasmByteCode).toString("base64"),
      },
    };
  }
}

export class MsgInstantiateContract<T> implements Adapter {
  constructor(
    private readonly data: {
      sender: string;
      admin?: string;
      codeId: bigint;
      label: string;
      msg: T;
      funds: Coin[];
    }
  ) {}

  public toProto() {
    return new ProtoMsgInstantiateContract({
      sender: this.data.sender,
      admin: this.data.admin ?? "",
      codeId: this.data.codeId,
      label: this.data.label,
      msg: new TextEncoder().encode(JSON.stringify(this.data.msg)),
      funds: this.data.funds,
    });
  }

  public toAmino() {
    return {
      type: "wasm/MsgInstantiateContract",
      value: {
        sender: this.data.sender,
        admin: this.data.admin ?? "",
        code_id: this.data.codeId.toString(),
        label: this.data.label,
        msg: this.data.msg,
        funds: this.data.funds,
      },
    };
  }
}
