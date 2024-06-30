import * as Bitcoin from "bitcoinjs-lib";
import axios from "axios"
import { RuneId, Runestone, none } from "runelib";

const network = Bitcoin.networks.testnet;
const UNISAT_URL = "https://open-api-tesnet.unisat.io";
const UNISAT_TOKEN = "Your unisat api token.";

interface IUtxo {
    txid: string;
    vout: number;
    value: number;
    scriptpubkey?: string;
}

interface IRuneUtxo {
    txid: string;
    vout: number;
    value: number;
    scriptpubkey: string;
    amount: number;
    divisibility: number;
}


const getBtcUtxoByAddress = async (address: string) => {
    const url = `${UNISAT_URL}/v1/indexer/address/${address}/utxo-data`;
    const config = {
        headers: {
            Authorization: `Bearer ${UNISAT_TOKEN}`,
        },
    };

    let cursor = 0;
    const size = 5000;
    const utxos: IUtxo[] = [];

    const res = await axios.get(url, { ...config, params: { cursor, size } });

    if (res.data.code === -1) throw "Invalid Address";

    utxos.push(
        ...(res.data.data.utxo as any[]).map((utxo) => {
            return {
                scriptpubkey: utxo.scriptPk,
                txid: utxo.txid,
                value: utxo.satoshi,
                vout: utxo.vout,
            };
        })
    );

    return utxos;
};

const getRuneUtxoByAddress = async (address: string, runeId: string) => {
    const url = `${UNISAT_URL}/v1/indexer/address/${address}/runes/${runeId}/utxo`;

    const config = {
        headers: {
            Authorization: `Bearer ${UNISAT_TOKEN}`,
        },
    };
    let tokenSum = 0;
    let start = 0;
    let divisibility = 0;
    const limit = 500;
    const utxos: IRuneUtxo[] = [];
    while (1) {
        const res = await axios.get(url, { ...config, params: { start, limit } });
        if (res.data.data.utxo.length === 0) break;
        if (res.data.code === -1) throw "Invalid Address";
        utxos.push(
            ...(res.data.data.utxo as any[]).map((utxo) => {
                tokenSum += Number(utxo.runes[0].amount);
                return {
                    scriptpubkey: utxo.scriptPk,
                    txid: utxo.txid,
                    value: utxo.satoshi,
                    vout: utxo.vout,
                    amount: Number(utxo.runes[0].amount),
                    divisibility: utxo.runes[0].divisibility,
                };
            })
        );
        start += res.data.data.utxo.length;
        if (start === res.data.data.total) break;
    }
    return { runeUtxos: utxos, tokenSum, divisibility };
};

const getFeeRate = async () => {
    try {
        const url = `https://mempool.space/testnet/api/v1/fees/recommended`;

        const res = await axios.get(url);

        return res.data.fastestFee;
    } catch (error) {
        return 40 * 3;
    }
};

const calculateTxFee = (psbt: Bitcoin.Psbt, feeRate: number) => {
    const tx = new Bitcoin.Transaction();

    for (let i = 0; i < psbt.txInputs.length; i++) {
        const txInput = psbt.txInputs[i];
        tx.addInput(txInput.hash, txInput.index, txInput.sequence);
        tx.setWitness(i, [Buffer.alloc(126)]);
    }

    for (let txOutput of psbt.txOutputs) {
        tx.addOutput(txOutput.script, txOutput.value);
    }
    tx.addOutput(psbt.txOutputs[0].script, psbt.txOutputs[0].value);
    tx.addOutput(psbt.txOutputs[0].script, psbt.txOutputs[0].value);

    return Math.floor((tx.virtualSize() * feeRate) / 1.4);
};

const generateSplitRunePsbt = async (
    address: string,
    pubkey: string,
    amount: number,
    runeId: string
) => {
    const btcUtxos = await getBtcUtxoByAddress(address);

    const runeUtxos = await getRuneUtxoByAddress(address, runeId);


    if (runeUtxos.tokenSum < amount) {
        throw "Invalid Amount";
    }

    const runeBlockNumber = parseInt(runeId.split(":")[0]);
    const runeTxout = parseInt(runeId.split(":")[1]);

    const psbt = new Bitcoin.Psbt({ network: network });

    const edicts: any = [];

    let tokenSum = 0;

    for (const runeutxo of runeUtxos.runeUtxos) {
        if (tokenSum < amount) {

            psbt.addInput({
                hash: runeutxo.txid,
                index: runeutxo.vout,
                tapInternalKey: Buffer.from(pubkey as string, "hex").slice(1, 33),
                witnessUtxo: {
                    value: runeutxo.value,
                    script: Buffer.from(runeutxo.scriptpubkey as string, "hex"),
                },
            });
            tokenSum += runeutxo.amount;
        }
    }
    edicts.push({
        id: new RuneId(runeBlockNumber, runeTxout),
        amount: amount,
        output: 2,
    });
    edicts.push({
        id: new RuneId(runeBlockNumber, runeTxout),
        amount: tokenSum - amount,
        output: 1,
    });
    const mintstone = new Runestone(edicts, none(), none(), none());

    psbt.addOutput({
        script: mintstone.encipher(),
        value: 0,
    });

    psbt.addOutput({
        address: address,
        value: 546,
    });

    psbt.addOutput({
        address: address,
        value: 546,
    });

    let totalBtcAmount = 0;

    const feeRate = Math.max(await getFeeRate(), 150);
    for (const btcutxo of btcUtxos) {
        const fee = calculateTxFee(psbt, feeRate);
        if (totalBtcAmount < fee && btcutxo.value > 10000) {
            totalBtcAmount += btcutxo.value;
            psbt.addInput({
                hash: btcutxo.txid,
                index: btcutxo.vout,
                tapInternalKey: Buffer.from(pubkey, "hex").slice(1, 33),
                witnessUtxo: {
                    script: Buffer.from(btcutxo.scriptpubkey as string, "hex"),
                    value: btcutxo.value,
                },
            });
        }
    }

    const fee = calculateTxFee(psbt, feeRate);

    if (totalBtcAmount < fee) throw "Btc balance is not enough";

    psbt.addOutput({
        address: address,
        value: totalBtcAmount - fee,
    });

    return psbt;
}